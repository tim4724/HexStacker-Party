'use strict';

// =====================================================================
// AirConsole Display Bootstrap
// Loaded AFTER all normal display scripts but BEFORE display.js init runs.
// Overrides PartyConnection so that connectAndCreateRoom() — which sets up
// callbacks and calls party.connect() — works with AirConsole instead.
// =====================================================================

// DisplayState.js already read muted from real localStorage before this
// bootstrap ran — reset it here so AC starts unmuted regardless. The
// storage shim is installed below but excludes stacker_muted, so future
// reads return null and music defaults on every session.
muted = false;

var airconsole = new AirConsole({
  orientation: AirConsole.ORIENTATION_LANDSCAPE,
  silence_inactive_players: false
});

// Install the AC-backed localStorage shim. The display itself doesn't
// read or write any allowlisted key — `muted = false` above resets the
// display's music mute directly — but installing the shim guarantees
// any incidental localStorage call from shared code (e.g. CSP-enabled
// libraries) silently no-ops instead of bleeding state into the AC
// iframe storage partition.
// The display reads/writes no allowlisted keys (muted is reset above), so the
// shim installs with an empty allowlist purely to no-op incidental
// localStorage calls inside the AC iframe storage partition.
AirConsoleStorage.install(airconsole, { allowlist: [] });

// Apply the AC-profile locale before the lobby's first paint. Passed to the
// adapter as its onReady hook so the kit stays i18n-agnostic.
function applyAcLocale() {
  if (typeof airconsole.getLanguage !== 'function') return;
  if (typeof LOCALES === 'undefined' || typeof setLocale !== 'function' || typeof translatePage !== 'function') return;
  var acLang = airconsole.getLanguage();
  var acCode = acLang && acLang.toLowerCase().split('-')[0];
  if (acCode && LOCALES[acCode]) { setLocale(acLang); translatePage(); }
}

// AirConsole fires onReady at most once per page load. The display needs
// multi-shot replay because New Game / reconnect creates fresh adapters; the
// controller can use AirConsoleAdapter.captureEarlyReady's one-shot replay.
var _cachedAcReadyCode;
airconsole.onReady = function(code) { _cachedAcReadyCode = code; };

// Wire AirConsole pause/resume — silently freeze the game engine.
// No overlay, no broadcast to controllers. AirConsole auto-resumes
// when the connection stabilizes.
var _acPaused = false;
var _adPaused = false;
var _adMutedByUs = false;

airconsole.onPause = function() {
  if (roomState !== ROOM_STATE.PLAYING && roomState !== ROOM_STATE.COUNTDOWN) return;
  _acPaused = true;
  if (paused) return;
  paused = true;
  setAutoPaused(true);
  if (roomState === ROOM_STATE.COUNTDOWN) clearCountdownTimers();
  if (displayGame) displayGame.pause();
  if (music) music.pause();
};

airconsole.onResume = function() {
  if (!_acPaused) return;
  _acPaused = false;
  if (_adPaused) return;
  if (autoPaused) { setAutoPaused(false); resumeGame(); }
};

// Wire ad events — pause and mute during ads, resume after.
airconsole.onAdShow = function() {
  if (roomState === ROOM_STATE.PLAYING || roomState === ROOM_STATE.COUNTDOWN) {
    _adPaused = true;
    if (!paused) {
      paused = true;
      setAutoPaused(true);
      if (roomState === ROOM_STATE.COUNTDOWN) clearCountdownTimers();
      if (displayGame) displayGame.pause();
    }
  }
  if (music && !muted) { music.pause(); _adMutedByUs = true; }
};

airconsole.onAdComplete = function() {
  var adWasMuted = _adMutedByUs;
  if (_adMutedByUs) _adMutedByUs = false;
  if (!_adPaused) { if (adWasMuted && music) music.resume(); return; }
  _adPaused = false;
  if (_acPaused) return;
  var canResume = autoPaused && !allPlayersDisconnected();
  if (adWasMuted && (canResume || !paused)) { if (music) music.resume(); }
  if (canResume) { setAutoPaused(false); resumeGame(); }
};

// Guard checkAutoResume — don't resume while ad or platform pause is active.
var _origCheckAutoResume = checkAutoResume;
checkAutoResume = function() {
  if (_adPaused || _acPaused) return;
  _origCheckAutoResume();
};

// Request an ad break on game-end. All paths into RESULTS funnel through
// setRoomState, so this single hook covers natural finish, test harness, and
// replay. Hooking the *exit* from RESULTS (Play Again, New Game) would race:
// showAd is async, onAdShow would arrive after we've already transitioned into
// COUNTDOWN, and would clearCountdownTimers() without a restart path on resume.
// AirConsole rate-limits showAd internally, so no extra throttle is needed.
var _origSetRoomState = setRoomState;
setRoomState = function(newState) {
  var before = roomState;
  var ok = _origSetRoomState(newState);
  // Only request the ad break on a real transition into RESULTS.
  if (ok && before !== ROOM_STATE.RESULTS && newState === ROOM_STATE.RESULTS) {
    try { airconsole.showAd(); } catch (e) {}
  }
  // Leaving RESULTS (Play Again, New Game, return to lobby): stop the
  // leaderboard auto-toggle and collapse the panel so the next round's
  // results screen starts clean. The next round repopulates from scratch.
  if (ok && before === ROOM_STATE.RESULTS && newState !== ROOM_STATE.RESULTS) {
    _hsStopToggle();
    if (_hsRefetchTimer) { clearTimeout(_hsRefetchTimer); _hsRefetchTimer = null; }
    if (_hsPumpWatchdog) { clearTimeout(_hsPumpWatchdog); _hsPumpWatchdog = null; }
    hideGlobalLeaderboard();
    annotateResultWorldRanks(null);
  }
  return ok;
};

// =====================================================================
// Global highscores (AirConsole native High Score API)
// On game end, store each played player's lines to two boards — all-time and
// the current month — keyed by level_version. Then fetch both and render a
// global top-10 panel on the results screen that auto-toggles between the
// boards a session player actually ranks in (world top 100). See plan.
// =====================================================================

var HS_LEVEL_NAME = 'HexStacker Party'; // human-readable; shows in AC share image
var HS_SCHEMA = 'v1-';                  // scoring-schema prefix; bump to fork boards
var HS_RANK_CUTOFF = 100;               // show a board only if a session player is in the world top N
var HS_TOGGLE_MS = 6000;

// level_version per board. Month is computed live (UTC) so a display left open
// across a month boundary files into the right bucket.
function hsBoardVersion(key) {
  if (key === 'month') {
    var d = new Date();
    var m = d.getUTCMonth() + 1;
    return HS_SCHEMA + d.getUTCFullYear() + '-' + (m < 10 ? '0' + m : m);
  }
  return HS_SCHEMA + 'all';
}
function hsBoardKeyForVersion(v) {
  if (v === hsBoardVersion('all')) return 'all';
  if (v === hsBoardVersion('month')) return 'month';
  return null;
}

// boardKey -> { entries:[{rank,name,scoreString}], rankByPlayerId:{}, qualifies:bool }
var _hsCache = {};
var _hsPlayerUids = {};        // playerId -> uid, for the current round
var _hsActiveBoard = 'all';
var _hsTogglePinned = false;   // a manual pill click stops auto-rotation
var _hsToggleTimer = null;
var _hsRequestQueue = [];
var _hsRequestInFlight = false;
var _hsPendingBoard = null;
var _hsRefetchTimer = null;
var _hsPumpWatchdog = null;

function acStoreHighScores(msg) {
  // `airconsole` is this file's own var, always set; the typeof guard covers
  // the AC_MOCK / older-SDK path where the High Score API is absent.
  if (typeof airconsole.storeHighScore !== 'function') return;
  if (!msg || !msg.results || msg._hsStored) return;
  msg._hsStored = true;

  var played = msg.results.filter(function(r) {
    return typeof r.rank === 'number' && !r.newPlayer;
  });
  if (!played.length) return;

  // Fresh round: reset cache, toggle, active board, and the request pipeline.
  // Resetting the queue/in-flight is essential — a Play Again that lands before
  // the previous round's onHighScores arrives would otherwise leave a stale
  // in-flight flag set, stranding this round's requests behind it.
  _hsCache = {};
  _hsPlayerUids = {};
  _hsTogglePinned = false;
  _hsActiveBoard = 'all';
  _hsRequestQueue = [];
  _hsRequestInFlight = false;
  _hsPendingBoard = null;
  if (_hsRefetchTimer) { clearTimeout(_hsRefetchTimer); _hsRefetchTimer = null; }
  if (_hsPumpWatchdog) { clearTimeout(_hsPumpWatchdog); _hsPumpWatchdog = null; }

  var boards = ['all', 'month'];
  for (var i = 0; i < played.length; i++) {
    var r = played[i];
    var uid = airconsole.getUID(r.playerId);
    if (!uid) continue; // controller dropped at game end — no UID to attribute
    _hsPlayerUids[r.playerId] = uid;
    // A 0-line result (instant topout) isn't worth a new board entry — skip the
    // store but keep the uid so any prior best still surfaces a world-rank badge.
    if (!(r.lines > 0)) continue;
    for (var b = 0; b < boards.length; b++) {
      try {
        // score_string is English (AC's own share image); our render localizes
        // from the numeric score instead.
        airconsole.storeHighScore(HS_LEVEL_NAME, hsBoardVersion(boards[b]), r.lines,
          uid, { level: r.level }, r.lines + ' lines');
      } catch (e) { /* NaN guard / SDK throw */ }
    }
  }

  // Prefetch both boards so the auto-toggle has data to cycle through. This
  // races the storeHighScore calls above, so the first paint may show pre-store
  // data; onHighScoreStored re-fetches once the new bests are confirmed.
  requestHighScoresFor('all');
  requestHighScoresFor('month');
}

// Wrap the global results renderer so storing rides on the single funnel for
// live end, test harness and reconnect-restore (DisplayGame.js onGameEnd).
var _origOnGameEnd = onGameEnd;
onGameEnd = function(msg) {
  _origOnGameEnd(msg);
  acStoreHighScores(msg);
};

// One request in flight at a time; onHighScores pumps the next. Dedupe so a
// burst of onHighScoreStored re-fetches can't pile redundant requests for the
// same board onto the queue.
function requestHighScoresFor(boardKey) {
  if (typeof airconsole.requestHighScores !== 'function') return;
  if (_hsRequestQueue.indexOf(boardKey) === -1) _hsRequestQueue.push(boardKey);
  _hsPumpRequests();
}
function _hsPumpRequests() {
  if (_hsRequestInFlight || !_hsRequestQueue.length) return;
  var key = _hsRequestQueue.shift();
  _hsRequestInFlight = true;
  _hsPendingBoard = key;
  // Watchdog: if the SDK accepts the request but never fires onHighScores
  // (network blip / SDK quirk), clear in-flight after 10s so the queue can't
  // stall the panel permanently.
  if (_hsPumpWatchdog) clearTimeout(_hsPumpWatchdog);
  _hsPumpWatchdog = setTimeout(function() {
    _hsPumpWatchdog = null;
    _hsRequestInFlight = false;
    _hsPendingBoard = null;
    _hsPumpRequests();
  }, 10000);
  try {
    // undefined uids = all connected controllers, so our players' own entries
    // (with their ranks.world) come back alongside the global top 10.
    // top=10 leaders to display; total=20 leaves room (total - top) for the
    // connected players' own context entries, so a player ranked outside the
    // top 10 still gets their world rank back for the per-row badge.
    airconsole.requestHighScores(HS_LEVEL_NAME, hsBoardVersion(key), undefined, ['world'], 20, 10);
  } catch (e) {
    _hsRequestInFlight = false;
    _hsPendingBoard = null;
    _hsPumpRequests();
  }
}

airconsole.onHighScoreStored = function(/* high_score */) {
  // Fires once per storeHighScore that set a new best — up to 2xN times a round.
  // Debounce into a single re-fetch so the board updates once the storm settles.
  // Don't clear the cache: _hsIngestBoard overwrites each board's entry when its
  // response lands, so clearing here would only risk a mid-flight blank.
  if (_hsRefetchTimer) clearTimeout(_hsRefetchTimer);
  _hsRefetchTimer = setTimeout(function() {
    _hsRefetchTimer = null;
    requestHighScoresFor('all');
    requestHighScoresFor('month');
  }, 600);
};

airconsole.onHighScores = function(list) {
  if (_hsPumpWatchdog) { clearTimeout(_hsPumpWatchdog); _hsPumpWatchdog = null; }
  list = list || [];
  // Route by the version on the returned entries; fall back to the pending
  // board when the list is empty (an empty board carries no version) or when
  // the version is unrecognized (e.g. the UTC month rolled over between the
  // request and this response).
  var boardKey = (list[0] && hsBoardKeyForVersion(list[0].level_version)) || _hsPendingBoard;
  _hsRequestInFlight = false;
  _hsPendingBoard = null;
  if (boardKey) _hsIngestBoard(boardKey, list);
  _hsPumpRequests();
  _hsRefreshDisplay();
};

// AirConsole's High Score typedef documents uids/nicknames as pipe-joined
// strings, but the live SDK (1.11.x) returns plain arrays. Normalize both so a
// future SDK change in either direction keeps matching/naming working.
function _hsToList(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') return v.split('|');
  return [];
}
function _hsFirstOf(v) {
  var list = _hsToList(v);
  return list.length ? list[0] : '';
}

function _hsIngestBoard(key, list) {
  var uidToPlayer = {};
  for (var pid in _hsPlayerUids) uidToPlayer[_hsPlayerUids[pid]] = pid;

  var rankByPlayerId = {};
  var bestRank = Infinity;
  var top = [];
  var seenUid = {};

  for (var i = 0; i < list.length; i++) {
    var e = list[i];
    var world = e.ranks && e.ranks.world;
    if (world == null) continue;
    var firstUid = _hsFirstOf(e.uids);
    // Map every session player's rank (used for per-row badges + the gate).
    var uids = _hsToList(e.uids);
    for (var u = 0; u < uids.length; u++) {
      var p = uidToPlayer[uids[u]];
      if (p != null) {
        rankByPlayerId[p] = world;
        if (world < bestRank) bestRank = world;
      }
    }
    // Collect entries for the top-10 panel (dedupe by user).
    if (!seenUid[firstUid]) {
      seenUid[firstUid] = true;
      top.push({ rank: world, name: _hsFirstOf(e.nicknames) || t('player'),
                 scoreString: t('n_lines', { count: e.score }) });
    }
  }
  top.sort(function(a, b) { return a.rank - b.rank; });

  _hsCache[key] = {
    entries: top.slice(0, 10),
    rankByPlayerId: rankByPlayerId,
    qualifies: bestRank <= HS_RANK_CUTOFF
  };
}

function _hsQualifyingBoards() {
  var out = [];
  ['all', 'month'].forEach(function(k) {
    if (_hsCache[k] && _hsCache[k].qualifies) out.push(k);
  });
  return out;
}

function _hsShowBoard(key) {
  var board = _hsCache[key];
  if (!board) return;
  _hsActiveBoard = key;
  renderGlobalLeaderboard(board.entries, key);
  annotateResultWorldRanks(board.rankByPlayerId);
}

function _hsRefreshDisplay() {
  if (roomState !== ROOM_STATE.RESULTS) return;
  var qualifying = _hsQualifyingBoards();
  if (!qualifying.length) {
    _hsStopToggle();
    hideGlobalLeaderboard();
    annotateResultWorldRanks(null);
    return;
  }
  if (qualifying.indexOf(_hsActiveBoard) === -1) _hsActiveBoard = qualifying[0];
  _hsShowBoard(_hsActiveBoard);
  if (!_hsTogglePinned && qualifying.length > 1) _hsStartToggle();
  else _hsStopToggle();
}

function _hsStartToggle() {
  _hsStopToggle();
  _hsToggleTimer = setInterval(function() {
    var q = _hsQualifyingBoards();
    if (q.length < 2) { _hsStopToggle(); return; }
    var idx = q.indexOf(_hsActiveBoard);
    _hsShowBoard(q[(idx + 1) % q.length]);
  }, HS_TOGGLE_MS);
}
function _hsStopToggle() {
  if (_hsToggleTimer) { clearInterval(_hsToggleTimer); _hsToggleTimer = null; }
}

// Manual override: tapping a pill pins that board (any cached board, even one
// the session didn't rank in) and stops auto-rotation for this results screen.
(function wireGlobalLeaderboardTabs() {
  if (!globalLeaderboard) return;
  var tabs = globalLeaderboard.querySelectorAll('.gl-tab');
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].addEventListener('click', function() {
      var key = this.getAttribute('data-board');
      if (!_hsCache[key]) return;
      _hsTogglePinned = true;
      _hsStopToggle();
      _hsShowBoard(key);
    });
  }
})();

// Replace PartyConnection with a factory that returns AirConsoleAdapter.
// `window.` qualifier is required: PartyConnection.js is stripped from the AC
// build, so no prior binding exists and strict-mode would reject a bare
// assignment with ReferenceError.
window.PartyConnection = function() {
  var adapter = new AirConsoleAdapter(airconsole, { role: 'display', onReady: applyAcLocale });
  var adapterOnReady = airconsole.onReady;
  airconsole.onReady = function(code) {
    _cachedAcReadyCode = code;
    adapterOnReady.call(airconsole, code);
  };
  return adapter;
};

// After connectAndCreateRoom() creates the adapter via new PartyConnection()
// and calls party.connect(), replay early onReady if the SDK fired before
// the adapter was wired.
var _originalConnectAndCreateRoom = connectAndCreateRoom;
connectAndCreateRoom = function() {
  _originalConnectAndCreateRoom();
  if (_cachedAcReadyCode !== undefined) airconsole.onReady(_cachedAcReadyCode);
};

// No /api/qr in AirConsole — short-circuit so callers see qrMatrix=null
// instead of a doomed fetch + console.error. fetchBaseUrl already returns
// early outside of localhost; renderQR already null-guards on its own.
fetchQR = function(text, cb) { if (cb) cb(null); };

// Init music when game starts — AirConsole's iframe has allow="autoplay" so we
// don't need a user gesture. In standalone mode, initMusic() is called on button click.
// startGame is defined in DisplayGame.js which loads before this script.
var _origStartGame = startGame;
startGame = function() {
  initMusic();
  _origStartGame();
};

// Skip welcome screen — go straight to lobby.
// onRoomCreated caches as preCreatedRoom when currentScreen === WELCOME,
// so setting it to LOBBY ensures the room is applied immediately.
currentScreen = SCREEN.LOBBY;

injectVersionLabel('lobby-version-label');

function appVersion() {
  var meta = document.querySelector('meta[name="app-version"]');
  return meta ? meta.getAttribute('content') : '';
}

function injectVersionLabel(elementId) {
  var el = document.getElementById(elementId);
  if (el) el.textContent = appVersion();
}

// Intercept showScreen(WELCOME) — in AirConsole there's no welcome screen.
// display.js defines resetToWelcome() which shows WELCOME; we redirect to LOBBY.
// No connectAndCreateRoom() here — resetToWelcome() already calls it after showScreen().
var _originalShowScreen = showScreen;
showScreen = function(name) {
  if (name === SCREEN.WELCOME) {
    _originalShowScreen(SCREEN.LOBBY);
    return;
  }
  _originalShowScreen(name);
};

// Don't touch session history in the AC iframe. The standalone web build
// pushes {screen:'game'} on countdown and pops it with history.back() on
// returnToLobby so the browser back button moves between lobby/game/results;
// inside AirConsole the platform watches the screen iframe's history and
// interprets history.back() as "game ended, reset the master controller",
// which tears down the master controller's iframe (observed in the
// simulator: the new-host late-joiner lands on about:blank on NEW GAME).
// Neutralize pushState so nothing ever lands on the stack, back so
// returnToLobbyUI's cleanup is a no-op, replaceState for good measure.
// Compare controller-airconsole.js which no-ops only pushState — the
// controller never calls history.back() from our code, so the simulator
// kill doesn't reach it.
history.pushState = function() {};
history.replaceState = function() {};
history.back = function() {};
