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

// Apply the AC-profile locale before the lobby's first paint. Part of the
// adapter's onReady hook so the kit stays i18n-agnostic.
function applyAcLocale() {
  if (typeof airconsole.getLanguage !== 'function') return;
  if (typeof LOCALES === 'undefined' || typeof setLocale !== 'function' || typeof translatePage !== 'function') return;
  var acLang = airconsole.getLanguage();
  var acCode = acLang && acLang.toLowerCase().split('-')[0];
  if (acCode && LOCALES[acCode]) { setLocale(acLang); translatePage(); }
}

// The locale first, so the lobby's records line renders in it, then the
// boards for that line. Runs again for each fresh adapter (New Game,
// reconnect), which keeps the line current.
function onAcReady() {
  applyAcLocale();
  requestBoards(hsVersions());
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
  // The platform froze us, not the host: the same display-internal category as
  // an all-disconnected auto-pause, so it reuses that reason. A host pause
  // already standing wins (RoomCore rule 2), so this no-ops rather than handing
  // their freeze to onResume below to lift.
  autoPause();
};

airconsole.onResume = function() {
  if (!_acPaused) return;
  _acPaused = false;
  if (_adPaused) return;
  autoResume();   // the AC freeze rides the AUTO reason, so this is what lifts it
};

// Wire ad events — pause and mute during ads, resume after.
airconsole.onAdShow = function() {
  if (roomState === ROOM_STATE.PLAYING || roomState === ROOM_STATE.COUNTDOWN) {
    _adPaused = true;
    autoPause();   // display-internal, like onPause above; a host pause wins
  }
  if (music && !muted) { music.pause(); _adMutedByUs = true; }
};

airconsole.onAdComplete = function() {
  var adWasMuted = _adMutedByUs;
  _adMutedByUs = false;
  if (!_adPaused) { if (adWasMuted && music) music.resume(); return; }
  _adPaused = false;
  if (_acPaused) return;
  // Refused unless the ad's own freeze is what's left (a host pause or a link
  // drop stands), and unless somebody is back to play. A successful thaw resumes
  // the music itself; the check below covers the case where we never froze.
  autoResume();
  if (adWasMuted && music && !paused) music.resume();
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
  if (ok && before === ROOM_STATE.RESULTS && newState !== ROOM_STATE.RESULTS) {
    stopGlobalBoards();
  }
  return ok;
};

// =====================================================================
// Global highscores (AirConsole High Score API)
// Every round offers each player's lines to two boards: all-time and the
// current UTC month. AirConsole has no time ranges, so the month rides in
// level_version. The results screen then shows each board's global top 10
// beside the standings, rotating between the two. Scores are public, so
// nothing personal is stored.
// =====================================================================

var HS_LEVEL = 'HexStacker Party';  // shown in AirConsole's share image
var HS_SCHEMA = 'v1-';              // scoring schema: bump it to fork both boards

// The SDK posts every store and request to the platform as a keyed `set`, and
// its callbacks don't say which call they answer, so the calls run one at a
// time. Stores queue first, so the requests read this round's scores.
var _hsQueue = [];
var _hsOp = null;      // the call awaiting its callback
var _hsPlayers = {};   // uid -> playerId, so this round's players stand out
var _hsBoards = {};    // board -> top 10, absent while the board is empty
var _hsNewBest = {};   // 'board|uid' -> true when this round set a new best

function hsRun(op) {
  _hsQueue.push(op);
  hsNext();
}

function hsNext() {
  if (_hsOp || !_hsQueue.length) return;
  var op = _hsOp = _hsQueue.shift();
  if (op.store) {
    airconsole.storeHighScore(HS_LEVEL, op.version, op.lines, op.uid, undefined, op.lines + ' lines');
  } else {
    airconsole.requestHighScores(HS_LEVEL, op.version, undefined, ['world'], 10, 10);
  }
}

// onGameEnd is the one funnel into results (match end and the engine-error
// salvage both call it once per round). The layout is set before the results
// paint, so the boards fade in later without moving anything.
var _origOnGameEnd = onGameEnd;
onGameEnd = function(msg) {
  reserveGlobalBoard();
  _origOnGameEnd(msg);
  storeHighScores(msg.results || []);
};

function hsVersions() {
  var d = new Date();
  var m = d.getUTCMonth() + 1;
  return { all: HS_SCHEMA + 'all', month: HS_SCHEMA + d.getUTCFullYear() + '-' + (m < 10 ? '0' : '') + m };
}

// Both boards' top 10: for the lobby line on ready, and for the results after
// each round's stores.
function requestBoards(versions) {
  hsRun({ board: 'all', version: versions.all });
  hsRun({ board: 'month', version: versions.month });
}

function storeHighScores(results) {
  var versions = hsVersions();
  _hsQueue = [];
  _hsOp = null;
  _hsPlayers = {};
  _hsBoards = {};
  _hsNewBest = {};
  for (var i = 0; i < results.length; i++) {
    var r = results[i];
    if (r.newPlayer) continue;  // sat this round out
    var uid = airconsole.getUID(r.playerId);
    if (!uid) continue;         // gone, no account to file it under
    _hsPlayers[uid] = r.playerId;
    if (!(r.lines > 0)) continue;  // a 0 would only add an empty entry
    // Month first: onHighScoreStored may drop the all-time store.
    hsRun({ store: true, board: 'month', version: versions.month, uid: uid, lines: r.lines });
    hsRun({ store: true, board: 'all', version: versions.all, uid: uid, lines: r.lines });
  }
  requestBoards(versions);
}

// Called with the stored entry when it is the player's new best, else null.
// Every score goes to both boards, so one that isn't the player's best this
// month can't be their all-time best either: that store is dropped.
airconsole.onHighScoreStored = function(highScore) {
  if (!_hsOp || !_hsOp.store) return;
  var op = _hsOp;
  _hsOp = null;
  if (highScore) {
    _hsNewBest[op.board + '|' + op.uid] = true;
  } else if (op.board === 'month') {
    _hsQueue = _hsQueue.filter(function(q) { return !(q.board === 'all' && q.uid === op.uid); });
  }
  hsNext();
};

airconsole.onHighScores = function(list) {
  if (!_hsOp || _hsOp.store) return;
  var board = _hsOp.board;
  _hsOp = null;
  hsNext();  // first, so an odd entry can't stop the queue
  hsIngest(board, list || []);
  showLobbyRecords(_hsBoards);
  if (roomState === ROOM_STATE.RESULTS) showGlobalBoards(_hsBoards);
};

// Documented as '|'-joined strings, sent as arrays by the live SDK. Our
// scores are single-player, so the first entry is the one.
function hsFirst(v) {
  return Array.isArray(v) ? v[0] : String(v || '').split('|')[0];
}

function hsIngest(board, list) {
  // An empty board drops the old one: a new month starts empty.
  if (!list.length) {
    delete _hsBoards[board];
    return;
  }
  _hsBoards[board] = list.map(function(e) {
    var uid = hsFirst(e.uids);
    return {
      rank: e.ranks.world,
      name: hsFirst(e.nicknames),
      lines: e.score,
      playerId: _hsPlayers[uid],
      best: !!_hsNewBest[board + '|' + uid]
    };
  }).sort(function(a, b) { return a.rank - b.rank; });
}

// Replace PartyConnection with a factory that returns AirConsoleAdapter.
// `window.` qualifier is required: PartyConnection.js is stripped from the AC
// build, so no prior binding exists and strict-mode would reject a bare
// assignment with ReferenceError.
window.PartyConnection = function() {
  var adapter = new AirConsoleAdapter(airconsole, { role: 'display', onReady: onAcReady });
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

// AirConsole players join via the AC app, not by scanning — suppress the QR so
// callers see qrMatrix=null (renderQR already null-guards on its own).
buildQRMatrix = function() { return null; };

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
