'use strict';

// =====================================================================
// Classic Mode — solo keyboard stacker with local high scores
// Depends on: DisplayState.js, DisplayGame.js, DisplayRender.js
// =====================================================================

var CLASSIC_PLAYER_ID = 'classic-player';
var CLASSIC_SCORE_KEY = 'hexstacker_classic_high_scores_v1';
var CLASSIC_NAME_KEY = 'hexstacker_classic_player_name_v1';
var CLASSIC_MAX_SCORES = 10;
var classicPressedKeys = new Set();
var classicSoftDropActive = false;

function resetClassicInputState() {
  classicPressedKeys.clear();
  classicSoftDropActive = false;
}

function sanitizeClassicName(name) {
  var cleaned = typeof name === 'string'
    ? name.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 12)
    : '';
  return cleaned || 'YOU';
}

function readClassicScores() {
  try {
    var raw = localStorage.getItem(CLASSIC_SCORE_KEY);
    if (!raw) return [];
    var parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(function(s) {
      return s && typeof s.lines === 'number' && typeof s.elapsedMs === 'number';
    }).slice(0, CLASSIC_MAX_SCORES);
  } catch (_) {
    return [];
  }
}

function compareClassicScores(a, b) {
  if ((b.lines || 0) !== (a.lines || 0)) return (b.lines || 0) - (a.lines || 0);
  if ((a.elapsedMs || 0) !== (b.elapsedMs || 0)) return (a.elapsedMs || 0) - (b.elapsedMs || 0);
  return String(a.date || '').localeCompare(String(b.date || ''));
}

function writeClassicScores(scores) {
  try {
    localStorage.setItem(CLASSIC_SCORE_KEY, JSON.stringify(scores.slice(0, CLASSIC_MAX_SCORES)));
  } catch (_) { /* storage unavailable */ }
}

function formatClassicTime(ms) {
  var total = Math.floor((ms || 0) / 1000);
  var min = Math.floor(total / 60);
  var sec = total % 60;
  return min + ':' + String(sec).padStart(2, '0');
}

function renderClassicHighScores() {
  if (!classicScoresList) return;
  var scores = readClassicScores().sort(compareClassicScores).slice(0, CLASSIC_MAX_SCORES);
  classicScoresList.innerHTML = '';
  if (scores.length === 0) {
    var empty = document.createElement('li');
    empty.textContent = t('classic_no_scores');
    classicScoresList.appendChild(empty);
    return;
  }
  for (var i = 0; i < scores.length; i++) {
    var s = scores[i];
    var li = document.createElement('li');
    var row = document.createElement('span');
    row.className = 'classic-score-row';
    var left = document.createElement('span');
    left.textContent = (s.name || 'YOU') + ' · ' + t('n_lines', { count: s.lines || 0 });
    var right = document.createElement('span');
    right.textContent = formatClassicTime(s.elapsedMs);
    row.appendChild(left);
    row.appendChild(right);
    li.appendChild(row);
    classicScoresList.appendChild(li);
  }
}

function recordClassicScore(result) {
  if (!result) return null;
  var entry = {
    name: sanitizeClassicName(classicPlayerName),
    lines: result.lines || 0,
    level: result.level || 1,
    elapsedMs: Math.round(result.elapsedMs || 0),
    date: new Date().toISOString()
  };
  var scores = readClassicScores();
  scores.push(entry);
  scores.sort(compareClassicScores);
  var rank = scores.indexOf(entry) + 1;
  scores = scores.slice(0, CLASSIC_MAX_SCORES);
  writeClassicScores(scores);
  return rank > 0 && rank <= CLASSIC_MAX_SCORES ? rank : null;
}

function syncClassicNameFromInput() {
  if (classicNameInput) {
    classicPlayerName = sanitizeClassicName(classicNameInput.value);
    classicNameInput.value = classicPlayerName;
  }
  try { localStorage.setItem(CLASSIC_NAME_KEY, classicPlayerName); } catch (_) {}
}

function prepareClassicPlayer() {
  syncClassicNameFromInput();
  players.clear();
  playerOrder = [CLASSIC_PLAYER_ID];
  players.set(CLASSIC_PLAYER_ID, {
    playerName: classicPlayerName,
    playerIndex: 0,
    startLevel: 1,
    lastPingTime: Date.now(),
    joinedAt: 1
  });
}

function startClassicGame() {
  gameMode = GameConstants.GAME_MODES.CLASSIC;
  resetClassicInputState();
  prepareClassicPlayer();
  stopDisplayGame();
  paused = false;
  setAutoPaused(false);
  lastResults = null;
  lastAliveState = {};
  disconnectedQRs.clear();
  garbageIndicatorEffects.clear();
  garbageDefenceEffects.clear();
  setRoomState(ROOM_STATE.COUNTDOWN);
  setRoomState(ROOM_STATE.PLAYING);
  acquireWakeLock();
  showScreen(SCREEN.GAME);
  runClassicGameWithSeed((Math.random() * 0xFFFFFFFF) >>> 0);
  if (music && !music.playing) music.start();
}

function runClassicGameWithSeed(seed) {
  stopDisplayGame();
  countdownOverlay.classList.add('hidden');
  countdownNumber.textContent = '';
  lastMusicLevel = 0;

  var Game = window.GameEngine.Game;
  var gamePlayers = new Map();
  gamePlayers.set(CLASSIC_PLAYER_ID, { startLevel: 1 });

  displayGame = new Game(gamePlayers, {
    onEvent: function(event) {
      if (event.type === 'line_clear') {
        onLineClear(event);
      } else if (event.type === 'player_ko') {
        onPlayerKO(event);
      } else if (event.type === 'piece_lock') {
        onPieceLock(event);
      }
    },
    onGameEnd: function(results) {
      if (results && results.results && results.results[0]) {
        results.results[0].playerName = classicPlayerName;
        results.results[0].colorIndex = 0;
        results.results[0].elapsedMs = results.elapsed || 0;
        classicLastResult = results.results[0];
        var rank = recordClassicScore(classicLastResult);
        classicLastRank = rank;
        if (classicResultPanel) {
          classicResultPanel.classList.remove('hidden');
          classicResultPanel.textContent = rank
            ? t('classic_new_score', { rank: rank })
            : t('classic_score_saved');
        }
      }
      setRoomState(ROOM_STATE.RESULTS);
      lastResults = results;
      onGameEnd(results);
      renderClassicHighScores();
    }
  }, seed, { pieceTypes: GameConstants.GAME_MODE_RULES.classic.pieceTypes });

  displayGame.init();
  gameState = displayGame.getSnapshot();
}

function endClassicToMenu() {
  if (music) music.stop();
  releaseWakeLock();
  resetClassicInputState();
  stopDisplayGame();
  paused = false;
  setAutoPaused(false);
  classicLastRank = null;
  if (roomState !== ROOM_STATE.LOBBY) {
    roomState = ROOM_STATE.LOBBY;
  }
  gameState = null;
  prevFrameTime = 0;
  showScreen(SCREEN.WELCOME);
  showWelcomeForCurrentView();
}

function classicActionForKey(e) {
  switch (e.key) {
    case 'ArrowLeft': return INPUT.LEFT;
    case 'ArrowRight': return INPUT.RIGHT;
    case 'ArrowUp':
    case 'x':
    case 'X': return INPUT.ROTATE_CW;
    case 'z':
    case 'Z': return INPUT.ROTATE_CCW;
    case ' ': return INPUT.HARD_DROP;
    case 'c':
    case 'C':
    case 'Shift': return INPUT.HOLD;
    default: return null;
  }
}

function onClassicKeyDown(e) {
  if (gameMode !== GameConstants.GAME_MODES.CLASSIC) return;
  if (currentScreen !== SCREEN.GAME && currentScreen !== SCREEN.RESULTS) return;
  if (e.target && /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(e.target.tagName)) return;

  if (e.key === 'p' || e.key === 'P' || e.key === 'Escape') {
    e.preventDefault();
    if (currentScreen === SCREEN.GAME) {
      if (paused) resumeGame(); else pauseGame();
    }
    return;
  }

  if (currentScreen !== SCREEN.GAME || roomState !== ROOM_STATE.PLAYING) return;
  if (classicPressedKeys.has(e.code || e.key)) return;
  classicPressedKeys.add(e.code || e.key);

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (!classicSoftDropActive && displayGame && !paused) {
      classicSoftDropActive = true;
      displayGame.handleSoftDropStart(CLASSIC_PLAYER_ID, 8);
    }
    return;
  }

  var action = classicActionForKey(e);
  if (!action) return;
  e.preventDefault();
  if (displayGame && !paused) displayGame.processInput(CLASSIC_PLAYER_ID, action);
}

function onClassicKeyUp(e) {
  if (gameMode !== GameConstants.GAME_MODES.CLASSIC) return;
  classicPressedKeys.delete(e.code || e.key);
  if (e.key === 'ArrowDown' && classicSoftDropActive) {
    e.preventDefault();
    classicSoftDropActive = false;
    if (displayGame) displayGame.handleSoftDropEnd(CLASSIC_PLAYER_ID);
  }
}

document.addEventListener('keydown', onClassicKeyDown);
document.addEventListener('keyup', onClassicKeyUp);
