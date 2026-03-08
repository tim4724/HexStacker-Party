'use strict';

// =====================================================================
// Controller State — shared globals across all controller script files.
// DOM queries are deferred to initControllerDOM() for testability.
//
// LOAD ORDER (required): ControllerState → ControllerConnection →
//   ControllerGame → controller.js
// See controller/index.html <script> tags for the canonical order.
// =====================================================================

// --- State ---
var party = null;
var clientId = null;
var playerColor = null;
var playerName = null;
var roomCode = null;
var touchInput = null;
var currentScreen = 'name';
var isHost = false;
var playerCount = 0;
var gameCancelled = false;
var lastLines = 0;
var lastGameResults = null;
var hintsFadeTimer = null;
var hintsSawLeft = false;
var hintsSawRight = false;

// Ping/pong
var PING_INTERVAL_MS = 1000;
var PONG_TIMEOUT_MS = 3000;
var pingTimer = null;
var pongCheckTimer = null;
var lastPongTime = 0;
var disconnectedTimer = null;

// Gesture feedback state
var lastTouchX = 0, lastTouchY = 0;
var coordTracker = null;
var softDropActive = false;
var softDropWash = null;
var buildupEl = null;
var buildupDir = null;

// Rejoin
var rejoinId = new URLSearchParams(location.search).get('rejoin');

// --- Viewport ---
function getViewportMetrics() {
  if (window.visualViewport) {
    return {
      width: Math.round(window.visualViewport.width),
      height: Math.round(window.visualViewport.height),
      offsetTop: Math.round(window.visualViewport.offsetTop || 0),
    };
  }
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    offsetTop: 0,
  };
}

function syncViewportLayout() {
  var metrics = getViewportMetrics();
  var keyboardInset = Math.max(0, window.innerHeight - metrics.height - metrics.offsetTop);
  var keyboardOpen = keyboardInset > 120
    && currentScreen === 'name'
    && document.activeElement === nameInput;

  document.documentElement.style.setProperty('--app-height', metrics.height + 'px');
  document.documentElement.style.setProperty('--keyboard-inset', keyboardInset + 'px');
  document.body.classList.toggle('keyboard-open', keyboardOpen);

  if (welcomeBg) {
    welcomeBg.resize(metrics.width, metrics.height);
  }
}

// --- Background ---
var bgCanvas = null;
var welcomeBg = null;

function initControllerBackground() {
  bgCanvas = document.getElementById('bg-canvas');
  if (bgCanvas) {
    welcomeBg = new WelcomeBackground(bgCanvas, 8);
    var metrics = getViewportMetrics();
    welcomeBg.resize(metrics.width, metrics.height);
    welcomeBg.start();
  }
  window.addEventListener('resize', syncViewportLayout);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncViewportLayout);
    window.visualViewport.addEventListener('scroll', syncViewportLayout);
  }
}

// --- DOM Refs (deferred to initControllerDOM for testability) ---
var nameForm = null;
var nameInput = null;
var nameJoinBtn = null;
var nameStatusText = null;
var nameStatusDetail = null;
var roomGoneMessage = null;
var roomGoneHeading = null;
var roomGoneDetail = null;
var nameScreen = null;
var lobbyScreen = null;
var lobbyBackBtn = null;
var waitingActionText = null;
var gameScreen = null;
var gameoverScreen = null;
var playerIdentity = null;
var startBtn = null;
var statusText = null;
var statusDetail = null;
var playerNameEl = null;
var playerIdentityName = null;
var touchArea = null;
var feedbackLayer = null;
var resultsList = null;
var gameoverButtons = null;
var playAgainBtn = null;
var newGameBtn = null;
var gameoverStatus = null;
var pauseBtn = null;
var pauseOverlay = null;
var pauseContinueBtn = null;
var pauseNewGameBtn = null;
var pauseStatus = null;
var pauseButtons = null;
var reconnectOverlay = null;
var reconnectHeading = null;
var reconnectStatus = null;
var reconnectRejoinBtn = null;
var pingDisplay = null;
var compassHints = null;
var muteBtn = null;

function initControllerDOM() {
  nameForm = document.getElementById('name-form');
  nameInput = document.getElementById('name-input');
  nameJoinBtn = document.getElementById('name-join-btn');
  nameStatusText = document.getElementById('name-status-text');
  nameStatusDetail = document.getElementById('name-status-detail');
  roomGoneMessage = document.getElementById('room-gone-message');
  roomGoneHeading = document.getElementById('room-gone-heading');
  roomGoneDetail = document.getElementById('room-gone-detail');
  nameScreen = document.getElementById('name-screen');
  lobbyScreen = document.getElementById('lobby-screen');
  lobbyBackBtn = document.getElementById('lobby-back-btn');
  waitingActionText = document.getElementById('waiting-action-text');
  gameScreen = document.getElementById('game-screen');
  gameoverScreen = document.getElementById('gameover-screen');
  playerIdentity = document.getElementById('player-identity');
  startBtn = document.getElementById('start-btn');
  statusText = document.getElementById('status-text');
  statusDetail = document.getElementById('status-detail');
  playerNameEl = document.getElementById('player-name');
  playerIdentityName = document.getElementById('player-identity-name');
  touchArea = document.getElementById('touch-area');
  feedbackLayer = document.getElementById('feedback-layer');
  resultsList = document.getElementById('results-list');
  gameoverButtons = document.getElementById('gameover-buttons');
  playAgainBtn = document.getElementById('play-again-btn');
  newGameBtn = document.getElementById('new-game-btn');
  gameoverStatus = document.getElementById('gameover-status');
  pauseBtn = document.getElementById('pause-btn');
  pauseOverlay = document.getElementById('pause-overlay');
  pauseContinueBtn = document.getElementById('pause-continue-btn');
  pauseNewGameBtn = document.getElementById('pause-newgame-btn');
  pauseStatus = document.getElementById('pause-status');
  pauseButtons = document.getElementById('pause-buttons');
  reconnectOverlay = document.getElementById('reconnect-overlay');
  reconnectHeading = document.getElementById('reconnect-heading');
  reconnectStatus = document.getElementById('reconnect-status');
  reconnectRejoinBtn = document.getElementById('reconnect-rejoin-btn');
  pingDisplay = document.getElementById('ping-display');
  compassHints = document.getElementById('compass-hints');
  muteBtn = document.getElementById('mute-btn');
}

// --- State Namespace (read-only accessor for testing and debugging) ---
var CS = {
  get currentScreen() { return currentScreen; },
  get clientId() { return clientId; },
  get playerName() { return playerName; },
  get playerColor() { return playerColor; },
  get roomCode() { return roomCode; },
  get isHost() { return isHost; },
  get playerCount() { return playerCount; },
  get gameCancelled() { return gameCancelled; }
};

// --- Screen Management ---
var SCREEN_ORDER = { name: 0, lobby: 1, game: 2, gameover: 3 };

function showScreen(name) {
  var prev = currentScreen;
  currentScreen = name;
  nameScreen.classList.toggle('hidden', name !== 'name');
  lobbyScreen.classList.toggle('hidden', name !== 'lobby');
  gameScreen.classList.toggle('hidden', name !== 'game');
  gameoverScreen.classList.toggle('hidden', name !== 'gameover');

  if (welcomeBg) {
    if (name === 'name' || name === 'lobby') {
      bgCanvas.classList.remove('hidden');
      welcomeBg.start();
    } else {
      welcomeBg.stop();
      bgCanvas.classList.add('hidden');
    }
  }

  if ((SCREEN_ORDER[name] || 0) > (SCREEN_ORDER[prev] || 0)) {
    history.pushState({ screen: name }, '');
  }

  syncViewportLayout();
}

// --- Helpers ---
function vibrate(pattern) {
  if (!navigator.vibrate) return;
  navigator.vibrate(pattern);
}

function generateClientId() {
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  var id = '';
  for (var i = 0; i < 12; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}
