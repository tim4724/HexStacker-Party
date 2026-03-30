'use strict';

// =====================================================================
// AirConsole Display Bootstrap
// Loaded AFTER all normal display scripts but BEFORE display.js init runs.
// Overrides PartyConnection so that connectAndCreateRoom() — which sets up
// callbacks and calls party.connect() — works with AirConsole instead.
// =====================================================================

var airconsole = new AirConsole({
  orientation: AirConsole.ORIENTATION_LANDSCAPE,
  silence_inactive_players: false
});

// Capture early onReady — the SDK may fire it before our adapter is wired up.
var _acEarlyReadyCode;
var _acEarlyReady = false;
airconsole.onReady = function(code) {
  _acEarlyReady = true;
  _acEarlyReadyCode = code;
};

// Wire AirConsole pause/resume to existing game pause.
// Show "CONNECTION UNSTABLE" on the display only — don't broadcast
// to controllers since they can't do anything about a connectivity issue
// and AirConsole will auto-resume when the connection stabilizes.
var _acConnectionPaused = false;

airconsole.onPause = function() {
  if (roomState !== ROOM_STATE.PLAYING && roomState !== ROOM_STATE.COUNTDOWN) return;
  if (paused) return;
  _acConnectionPaused = true;
  // Pause the engine and music directly without broadcasting to controllers
  paused = true;
  if (displayGame) displayGame.pause();
  if (music) music.pause();
  // Show overlay with connection message instead of pause buttons
  var heading = document.querySelector('#pause-overlay h1');
  var buttons = document.getElementById('pause-buttons');
  if (heading) heading.textContent = 'CONNECTION UNSTABLE';
  if (buttons) buttons.classList.add('hidden');
  pauseOverlay.classList.remove('hidden');
};

airconsole.onResume = function() {
  if (!_acConnectionPaused) return;
  _acConnectionPaused = false;
  // Restore normal pause overlay for future user-initiated pauses
  var heading = document.querySelector('#pause-overlay h1');
  var buttons = document.getElementById('pause-buttons');
  if (heading) heading.textContent = 'PAUSED';
  if (buttons) buttons.classList.remove('hidden');
  // Resume without broadcasting (controllers never knew about this pause)
  paused = false;
  if (displayGame) displayGame.resume();
  pauseOverlay.classList.add('hidden');
  if (music && !muted) music.resume();
};

// Replace PartyConnection with a factory that returns AirConsoleAdapter.
PartyConnection = function() {
  return new AirConsoleAdapter(airconsole, { role: 'display' });
};

// After connectAndCreateRoom() creates the adapter via new PartyConnection()
// and calls party.connect(), replay early onReady if the SDK fired before
// the adapter was wired.
var _originalConnectAndCreateRoom = connectAndCreateRoom;
connectAndCreateRoom = function() {
  _originalConnectAndCreateRoom();
  if (_acEarlyReady && party && !party.connected) {
    airconsole.onReady(_acEarlyReadyCode);
  }
};

// No local server APIs in AirConsole (QR, base URL)
fetchBaseUrl = function() {};
fetchQR = function(text, cb) { if (cb) cb(null); };

// renderQR no-op when qrMatrix is null
var _originalRenderQR = renderQR;
renderQR = function(canvas, matrix) {
  if (!matrix) return;
  _originalRenderQR(canvas, matrix);
};

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

// Intercept showScreen(WELCOME) — in AirConsole there's no welcome screen.
// display.js defines resetToWelcome() which shows WELCOME; we redirect to LOBBY.
var _originalShowScreen = showScreen;
showScreen = function(name) {
  if (name === SCREEN.WELCOME) {
    _originalShowScreen(SCREEN.LOBBY);
    connectAndCreateRoom();
    return;
  }
  _originalShowScreen(name);
};
