'use strict';

// =====================================================================
// Shared Display State — loaded first, all vars are globals
// =====================================================================

// --- Screen Constants ---
var SCREEN = { WELCOME: 'welcome', LOBBY: 'lobby', GAME: 'game', RESULTS: 'results' };

// --- URL Parameters ---
var urlParams = new URLSearchParams(window.location.search);
var debugCount = parseInt(urlParams.get('debug'), 10) || 0;

// --- State ---
var currentScreen = SCREEN.WELCOME;
var party = null;
var roomCode = null;
var joinUrl = null;
var lastRoomCode = null;
var lastInstance = null;       // relay instance id from `created` — pins reconnect / controller WS to the same shard
var gameState = null;
var players = new Map();       // peerIndex (number) -> { playerName, playerIndex, startLevel, lastPingTime, joinedAt }
                               // peerIndex is the relay slot id (1..N for controllers; the display
                               // itself owns index 0 and is not in this map). playerIndex is the
                               // chosen color slot, derived via PLAYER_COLORS[playerIndex] — never stored.
var playerOrder = [];          // compact list of active controller peerIndices for game layout. Lobby
                               // cards and in-game boards both sort by joinedAt; playerIndex is the
                               // chosen color slot only.
var hostPeerIndex = null;      // sticky host — the first joiner owns this slot; handoff happens
                               // only when the host actually leaves via onPeerLeft. Color changes
                               // do not affect it. See getHostPeerIndex() / electNextHost() below.
var _joinSequence = 0;         // monotonic counter for player.joinedAt — Date.now() collides
                               // when two peers arrive in the same ms, which matters for the
                               // electNextHost tiebreak and calculateLayout's stable sort.
var roomState = ROOM_STATE.LOBBY;

// Valid room state transitions
var VALID_TRANSITIONS = {};
VALID_TRANSITIONS[ROOM_STATE.LOBBY] = [ROOM_STATE.COUNTDOWN];
VALID_TRANSITIONS[ROOM_STATE.COUNTDOWN] = [ROOM_STATE.PLAYING, ROOM_STATE.LOBBY];
VALID_TRANSITIONS[ROOM_STATE.PLAYING] = [ROOM_STATE.RESULTS, ROOM_STATE.LOBBY];
VALID_TRANSITIONS[ROOM_STATE.RESULTS] = [ROOM_STATE.COUNTDOWN, ROOM_STATE.LOBBY];

function setRoomState(newState) {
  if (newState === roomState) return true;
  var allowed = VALID_TRANSITIONS[roomState];
  if (!allowed || allowed.indexOf(newState) < 0) {
    console.warn('Invalid room state transition: ' + roomState + ' → ' + newState);
    return false;
  }
  roomState = newState;
  return true;
}

var paused = false;
var autoPaused = false;
var lateJoinerGraceTimer = null;
var boardRenderers = [];
var uiRenderers = [];
var animations = null;
var music = null;
var canvas = null;
var ctx = null;
var disconnectedQRs = new Map();
var garbageIndicatorEffects = new Map();
var garbageDefenceEffects = new Map();
var welcomeBg = null;
var displayGame = null;
var baseUrlOverride = null;    // LAN base URL from server (fetched on init)

// Countdown state (display manages countdown since server no longer does)
var countdown = { timer: null, remaining: 0, callback: null, goTimeout: null, overlayTimer: null };

// Controller liveness
var livenessInterval = null;

// Display heartbeat — send echo to self via relay to verify connection
var lastHeartbeatEcho = 0;
var heartbeatSent = false;
var disconnectedTimer = null;

// Last alive state per player (for reconnect)
var lastAliveState = {};

// Last results (for reconnect)
var lastResults = null;

// Clear all room-local state — used when entering a fresh room or returning to welcome.
// Note: does not touch _lastBroadcastedHostId (module-private to DisplayConnection) or roomCode.
// Calls clearCountdownTimers() and clearLateJoinerGraceTimer() (defined in
// DisplayGame.js) — only safe after all scripts load.
function resetRoomData() {
  if (music) music.stop();
  clearCountdownTimers();
  countdown.callback = null;
  countdown.remaining = 0;
  players.clear();
  playerOrder = [];
  hostPeerIndex = null;
  _joinSequence = 0;
  paused = false;
  setAutoPaused(false);
  clearLateJoinerGraceTimer();
  gameState = null;
  boardRenderers = [];
  uiRenderers = [];
  disconnectedQRs.clear();
  garbageIndicatorEffects.clear();
  garbageDefenceEffects.clear();
  lastAliveState = {};
  lastResults = null;
}

// Browser history navigation state
var popstateNavigating = false;
var suppressPopstate = false;

// Pre-created room state (ready before user clicks "New Game")
var preCreatedRoom = null;  // { roomCode, joinUrl, qrMatrix }

// Mute
var muted = false;
try { muted = localStorage.getItem('stacker_muted') === '1'; } catch (e) { /* iframe sandbox */ }

// Render loop RAF handle (for stop/start)
var rafId = null;

// Cached window dimensions (updated on resize, avoids forced layout in render loop)
var cachedW = window.innerWidth;
var cachedH = window.innerHeight;

// Wake Lock — prevents screen sleep during active games
var wakeLock = null;

// RAF-driven game loop timing
var prevFrameTime = 0;

// --- Slot Helpers ---
// Find the first available player slot (0–3) not used by any current player
function nextAvailableSlot() {
  var used = [];
  for (const entry of players) {
    used.push(entry[1].playerIndex);
  }
  for (var i = 0; i < GameConstants.MAX_PLAYERS; i++) {
    if (used.indexOf(i) < 0) return i;
  }
  return -1;
}

var AUTO_PLAYER_NAME_RE = /^HX-([1-9][0-9]?)$/i;
var LEGACY_SLOT_NAME_RE = /^P[1-8]$/i;
// Exclude culturally unlucky numbers and one obvious content-adjacent number.
var AUTO_PLAYER_NAME_BLOCKLIST = [4, 13, 17, 69];

function getAutoPlayerNameNumber(name) {
  var match = typeof name === 'string' ? AUTO_PLAYER_NAME_RE.exec(name) : null;
  return match ? parseInt(match[1], 10) : null;
}

function isAllowedAutoPlayerNameNumber(num) {
  return num >= 1 && num <= 99 && AUTO_PLAYER_NAME_BLOCKLIST.indexOf(num) < 0;
}

function collectTakenAutoPlayerNameNumbers(exceptPeerIndex) {
  var taken = [];
  for (const entry of players) {
    if (entry[0] === exceptPeerIndex) continue;
    var num = getAutoPlayerNameNumber(entry[1].playerName);
    if (num != null) taken.push(num);
  }
  return taken;
}

function generateAutoPlayerName(exceptPeerIndex, preferredName) {
  var taken = collectTakenAutoPlayerNameNumbers(exceptPeerIndex);
  var preferredNum = getAutoPlayerNameNumber(preferredName);
  if (preferredNum != null
      && isAllowedAutoPlayerNameNumber(preferredNum)
      && taken.indexOf(preferredNum) < 0) {
    return 'HX-' + preferredNum;
  }

  var available = [];
  for (var i = 1; i <= 99; i++) {
    if (isAllowedAutoPlayerNameNumber(i) && taken.indexOf(i) < 0) {
      available.push(i);
    }
  }

  // MAX_PLAYERS is 8, so this fallback should only matter if test harnesses
  // deliberately fill every normal candidate.
  if (available.length === 0) {
    for (var j = 1; j <= 99; j++) {
      if (taken.indexOf(j) < 0) {
        available.push(j);
      }
    }
  }

  if (available.length === 0) return 'HX-1';
  return 'HX-' + available[Math.floor(Math.random() * available.length)];
}

// Sanitize player name. Empty names and legacy slot fallbacks become
// room-unique, language-neutral HX names that survive lobby compaction.
function sanitizePlayerName(name, peerIndex, requestedAutoName) {
  if (requestedAutoName || !name || LEGACY_SLOT_NAME_RE.test(name)) {
    return generateAutoPlayerName(peerIndex, name);
  }
  return name;
}

// Host = the connected player designated as master controller (AirConsole rule:
// "menus can only be controlled by the Master Controller"). In AirConsole mode
// we defer to the platform (premium devices get priority); otherwise we fall
// back to the sticky host — the first player to join. The stored slot survives
// color changes (host stays host when they pick a new palette slot) and brief
// disconnects (a reconnecting host keeps their role). Handoff happens only
// when the host actually leaves the room via onPeerLeft, which calls
// electNextHost() to reassign the slot to the next-oldest present player.
//
// During COUNTDOWN/PLAYING/RESULTS the candidate set is restricted to active
// game participants (playerOrder). A late joiner — promoted to AC master, or
// the sticky host whose slot was handed off to a participant — must not
// control menu actions they can't reach (their screen is a "Game in progress"
// banner with no pause overlay). Host opens back up to everyone in LOBBY where
// late joiners have already been folded into playerOrder.
//
// Disconnected players (flagged via disconnectedQRs) are skipped so the host
// role temporarily defers to a present player during a mid-game reconnect.
// If the stored hostPeerIndex is unavailable (disconnected / ineligible), the
// fallback returns the oldest-joined present player WITHOUT mutating
// hostPeerIndex — the sticky slot only moves when onPeerLeft hands it off.
// NOTE: tests/display-state.test.js mirrors this algorithm — keep in sync.
function getHostPeerIndex() {
  var restricted = (roomState === ROOM_STATE.PLAYING
                 || roomState === ROOM_STATE.COUNTDOWN
                 || roomState === ROOM_STATE.RESULTS)
                && playerOrder.length > 0;
  var eligible = restricted ? new Set(playerOrder) : null;

  if (party && typeof party.getMasterPeerIndex === 'function') {
    var acHost = party.getMasterPeerIndex();
    // Only trust it if the device has completed HELLO, is currently
    // connected, and (when restricted) is an active participant; otherwise
    // fall through until they qualify.
    if (acHost != null && players.has(acHost) && !disconnectedQRs.has(acHost)
        && (!restricted || eligible.has(acHost))) {
      return acHost;
    }
  }

  // Sticky host — preferred when currently available.
  if (hostPeerIndex != null && players.has(hostPeerIndex)
      && !disconnectedQRs.has(hostPeerIndex)
      && (!restricted || eligible.has(hostPeerIndex))) {
    return hostPeerIndex;
  }

  // Fallback: oldest-joined eligible present player. Read-only — the
  // sticky slot is reassigned explicitly by electNextHost() in onPeerLeft,
  // not here, so that a temporarily-disconnected host keeps their slot.
  var fallbackId = null;
  var fallbackJoin = Infinity;
  for (const entry of players) {
    if (disconnectedQRs.has(entry[0])) continue;
    if (restricted && !eligible.has(entry[0])) continue;
    var ja = entry[1].joinedAt == null ? Infinity : entry[1].joinedAt;
    if (ja < fallbackJoin) {
      fallbackJoin = ja;
      fallbackId = entry[0];
    }
  }
  return fallbackId;
}

// Pick the oldest-joined present player other than `excludeId` to become
// the new sticky host. Used by onPeerLeft when the departing player held
// the host slot. Returns null if nobody else qualifies (room will promote
// the next joiner via onPeerJoined's null-check).
// NOTE: tests/display-state.test.js mirrors this algorithm — keep in sync.
function electNextHost(excludeId) {
  var nextId = null;
  var nextJoin = Infinity;
  for (const entry of players) {
    if (entry[0] === excludeId) continue;
    if (disconnectedQRs.has(entry[0])) continue;
    var ja = entry[1].joinedAt == null ? Infinity : entry[1].joinedAt;
    if (ja < nextJoin) {
      nextJoin = ja;
      nextId = entry[0];
    }
  }
  return nextId;
}

// --- DOM References ---
var welcomeScreen = document.getElementById('welcome-screen');
var newGameBtn = document.getElementById('new-game-btn');
var lobbyScreen = document.getElementById('lobby-screen');
var gameScreen = document.getElementById('game-screen');
var resultsScreen = document.getElementById('results-screen');
var qrCode = document.getElementById('qr-code');
var joinUrlEl = document.getElementById('join-url');
var playerListEl = document.getElementById('player-list');
var startBtn = document.getElementById('start-btn');
var countdownOverlay = document.getElementById('countdown-overlay');
var countdownNumber = document.getElementById('countdown-number');
var resultsList = document.getElementById('results-list');
var playAgainBtn = document.getElementById('play-again-btn');
var newGameResultsBtn = document.getElementById('new-game-results-btn');
var gameToolbar = document.getElementById('game-toolbar');
var fullscreenBtn = document.getElementById('fullscreen-btn');
var pauseBtn = document.getElementById('pause-btn');
var pauseOverlay = document.getElementById('pause-overlay');
var pauseContinueBtn = document.getElementById('pause-continue-btn');
var pauseNewGameBtn = document.getElementById('pause-newgame-btn');
var reconnectOverlay = document.getElementById('reconnect-overlay');
var reconnectHeading = document.getElementById('reconnect-heading');
var reconnectStatus = document.getElementById('reconnect-status');
var reconnectBtn = document.getElementById('reconnect-btn');
var muteBtn = document.getElementById('mute-btn');

// Reflect stored mute state on the toolbar's mute button immediately —
// the HTML default (aria-checked="true", sound-waves visible) matches
// the unmuted case; for a user with stacker_muted=1 persisted, this
// syncs the DOM before AT reads it and before the toolbar is revealed.
if (muteBtn) {
  if (muted) muteBtn.querySelector('.sound-waves').style.display = 'none';
  muteBtn.setAttribute('aria-checked', muted ? 'false' : 'true');
}

// --- Screen Management ---
function showScreen(name) {
  var prev = currentScreen;
  currentScreen = name;
  // Suppress the mobile-hint overlay once the user is past the welcome
  // screen. Without this, narrowing a desktop browser during an active
  // lobby/game/results session would re-fire the size-based media query
  // in display.css and cover the board. Returning to WELCOME clears it
  // so the overlay can reappear for the next visitor on that device.
  document.documentElement.classList.toggle('in-session', name !== SCREEN.WELCOME);
  welcomeScreen.classList.toggle('hidden', name !== SCREEN.WELCOME);
  lobbyScreen.classList.toggle('hidden', name !== SCREEN.LOBBY);
  gameScreen.classList.toggle('hidden', name !== SCREEN.GAME && name !== SCREEN.RESULTS);
  resultsScreen.classList.toggle('hidden', name !== SCREEN.RESULTS);
  // Re-arm the results anti-misclick gate on fresh entry. Re-entering
  // RESULTS from itself preserves the --ready class added by
  // visibilitychange.
  if (name === SCREEN.RESULTS && prev !== SCREEN.RESULTS) {
    resultsScreen.classList.remove('results-screen--ready');
  }
  gameToolbar.classList.toggle('hidden', name === SCREEN.WELCOME);
  // Hide mute on lobby in AirConsole mode only — it would overlap with the
  // version label shown in that mode.
  muteBtn.classList.toggle(
    'hidden',
    name === SCREEN.LOBBY && document.body.classList.contains('airconsole')
  );
  pauseBtn.classList.toggle('hidden', name !== SCREEN.GAME);
  if (name !== SCREEN.GAME) {
    pauseOverlay.classList.add('hidden');
    reconnectOverlay.classList.add('hidden');
    gameToolbar.classList.remove('toolbar-autohide');
  }
  if (name === SCREEN.GAME || name === SCREEN.RESULTS) {
    if (!ctx) initCanvas();
    calculateLayout();
    startRenderLoop();
  } else {
    stopRenderLoop();
  }
  if (name === SCREEN.LOBBY) {
    updatePlayerList();
  }
  if (welcomeBg) {
    var bgCanvasEl = document.getElementById('bg-canvas');
    if (name === SCREEN.WELCOME || name === SCREEN.LOBBY) {
      if (bgCanvasEl) bgCanvasEl.classList.remove('hidden');
      welcomeBg.start();
    } else {
      welcomeBg.stop();
      // Drop the compositor layer during gameplay/results — RAF was already
      // stopped, this removes the full-viewport layer from the GPU too.
      if (bgCanvasEl) bgCanvasEl.classList.add('hidden');
    }
  }
}

// --- Canvas Setup ---
function initCanvas() {
  canvas = document.getElementById('game-canvas');
  // alpha:false lets the browser skip the alpha blend on composite to screen.
  // Safe because renderFrame starts every frame with an opaque bg.primary
  // fillRect, so the canvas has no reason to be translucent.
  ctx = canvas.getContext('2d', { alpha: false });
  resizeCanvas();
}

function resizeCanvas() {
  if (!canvas) return;
  cachedW = window.innerWidth;
  cachedH = window.innerHeight;
  var dpr = window.devicePixelRatio || 1;
  canvas.width = cachedW * dpr;
  canvas.height = cachedH * dpr;
  canvas.style.width = cachedW + 'px';
  canvas.style.height = cachedH + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (currentScreen === SCREEN.GAME) {
    calculateLayout();
  }
}
