'use strict';

// --- State ---
let currentScreen = 'welcome';
let gameState = null;
let ws = null;
let players = new Map(); // playerId -> { playerName, playerColor, playerIndex }
let playerOrder = [];    // ordered player IDs for layout
let boardRenderers = [];
let uiRenderers = [];
let animations = null;
let music = null;
let canvas = null;
let ctx = null;
let lastFrameTime = null;
let playerIndexCounter = 0;
let disconnectedQRs = new Map(); // playerId -> Canvas
let garbageIndicatorEffects = new Map(); // playerId -> transient attacker-colored meter block overlays
let lastRoomCode = null; // remember room code for reconnect
let welcomeBg = null;

// --- DOM References ---
const welcomeScreen = document.getElementById('welcome-screen');
const newGameBtn = document.getElementById('new-game-btn');
const lobbyScreen = document.getElementById('lobby-screen');
const gameScreen = document.getElementById('game-screen');
const resultsScreen = document.getElementById('results-screen');
const qrCode = document.getElementById('qr-code');
const joinUrlEl = document.getElementById('join-url');
const playerListEl = document.getElementById('player-list');
const startBtn = document.getElementById('start-btn');
const countdownOverlay = document.getElementById('countdown-overlay');
const resultsList = document.getElementById('results-list');
const playAgainBtn = document.getElementById('play-again-btn');
const newGameResultsBtn = document.getElementById('new-game-results-btn');
const gameToolbar = document.getElementById('game-toolbar');
const fullscreenBtn = document.getElementById('fullscreen-btn');
const pauseBtn = document.getElementById('pause-btn');
const pauseOverlay = document.getElementById('pause-overlay');
const pauseContinueBtn = document.getElementById('pause-continue-btn');
const pauseNewGameBtn = document.getElementById('pause-newgame-btn');
const muteBtn = document.getElementById('mute-btn');
let muted = false;

// --- Screen Management ---
function showScreen(name) {
  currentScreen = name;
  welcomeScreen.classList.toggle('hidden', name !== 'welcome');
  lobbyScreen.classList.toggle('hidden', name !== 'lobby');
  // Keep game screen visible behind results and pause overlays
  gameScreen.classList.toggle('hidden', name !== 'game' && name !== 'results');
  resultsScreen.classList.toggle('hidden', name !== 'results');
  // Keep fullscreen available after entering the display flow; pause remains game-only.
  gameToolbar.classList.toggle('hidden', name === 'welcome');
  pauseBtn.classList.toggle('hidden', name !== 'game');
  // Hide pause overlay when switching away from game
  if (name !== 'game') {
    pauseOverlay.classList.add('hidden');
  }

  if (name === 'game' || name === 'results') {
    initCanvas();
    calculateLayout();
  }

  // Ensure player slots are visible as soon as the lobby appears
  if (name === 'lobby') {
    updatePlayerList();
  }

  // Manage falling tetromino background (shared across welcome + lobby)
  if (welcomeBg) {
    if (name === 'welcome' || name === 'lobby') welcomeBg.start();
    else welcomeBg.stop();
  }
}

// --- Canvas Setup ---
function initCanvas() {
  canvas = document.getElementById('game-canvas');
  ctx = canvas.getContext('2d');
  resizeCanvas();
}

function resizeCanvas() {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  canvas.style.width = window.innerWidth + 'px';
  canvas.style.height = window.innerHeight + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  if (currentScreen === 'game') {
    calculateLayout();
  }
}

// --- Layout Calculation ---
function calculateLayout() {
  if (!ctx || playerOrder.length === 0) return;

  const n = playerOrder.length;
  const w = window.innerWidth;
  const h = window.innerHeight;
  const padding = THEME.size.canvasPad;

  // Each player needs: board (10 cells wide, 20 tall) + side panels (~3 cells each side)
  const totalCellsWide = 10 + 3 + 3; // board + hold panel + next panel
  const totalCellsTall = 20 + 3.6;       // board + name + score + bottom breathing room

  // Compute cell size for a given grid arrangement
  function cellSizeFor(cols, rows) {
    const aw = (w - padding * (cols + 1)) / cols;
    const ah = (h - padding * (rows + 1)) / rows;
    return Math.floor(Math.min(aw / totalCellsWide, ah / totalCellsTall));
  }

  // Determine grid arrangement — pick layout that maximizes cell size
  let gridCols, gridRows;
  if (n === 1) { gridCols = 1; gridRows = 1; }
  else if (n === 2) { gridCols = 2; gridRows = 1; }
  else if (n === 3) { gridCols = 3; gridRows = 1; }
  else {
    // 4 players: compare 4x1 row vs 2x2 grid
    if (cellSizeFor(4, 1) >= cellSizeFor(2, 2)) {
      gridCols = 4; gridRows = 1;
    } else {
      gridCols = 2; gridRows = 2;
    }
  }

  const cellSize = cellSizeFor(gridCols, gridRows);

  const boardWidthPx = 10 * cellSize;
  const boardHeightPx = 20 * cellSize;

  boardRenderers = [];
  uiRenderers = [];

  // Create Animations instance with the current context
  animations = new Animations(ctx);

  for (let i = 0; i < n; i++) {
    const col = i % gridCols;
    const row = Math.floor(i / gridCols);

    // Center each player's area within its grid cell
    const cellAreaW = w / gridCols;
    const cellAreaH = h / gridRows;
    const boardX = cellAreaW * col + (cellAreaW - boardWidthPx) / 2;
    const boardY = cellAreaH * row + (cellAreaH - boardHeightPx) / 2 + 10; // offset for name

    const playerIndex = players.get(playerOrder[i])?.playerIndex ?? i;

    boardRenderers.push(new BoardRenderer(ctx, boardX, boardY, cellSize, playerIndex));
    uiRenderers.push(new UIRenderer(ctx, boardX, boardY, cellSize, boardWidthPx, boardHeightPx, playerIndex));
  }
}

// --- WebSocket ---
function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`);

  ws.onopen = function() {
    ws.send(JSON.stringify({ type: MSG.CREATE_ROOM, roomCode: lastRoomCode }));
  };

  ws.onmessage = function(event) {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (_) {
      return;
    }
    handleMessage(msg);
  };

  ws.onclose = function() {
    // Attempt reconnect after delay
    setTimeout(connect, 2000);
  };
}

function send(type, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, ...data }));
  }
}

// --- Message Handlers ---
function handleMessage(msg) {
  switch (msg.type) {
    case MSG.ROOM_CREATED:
      onRoomCreated(msg);
      break;
    case MSG.PLAYER_JOINED:
      onPlayerJoined(msg);
      break;
    case MSG.PLAYER_LEFT:
      onPlayerLeft(msg);
      break;
    case MSG.ROOM_RESET:
      onRoomReset();
      break;
    case MSG.COUNTDOWN:
      onCountdown(msg);
      break;
    case MSG.GAME_STATE:
      onGameState(msg);
      break;
    case MSG.LINE_CLEAR:
      onLineClear(msg);
      break;
    case MSG.GARBAGE_SENT:
      onGarbageSent(msg);
      break;
    case MSG.PLAYER_KO:
      onPlayerKO(msg);
      break;
    case MSG.GAME_END:
      onGameEnd(msg);
      break;
    case MSG.PLAYER_DISCONNECTED:
      onPlayerDisconnected(msg);
      break;
    case MSG.PLAYER_RECONNECTED:
      onPlayerReconnected(msg);
      break;
    case MSG.GAME_PAUSED:
      onGamePaused();
      break;
    case MSG.GAME_RESUMED:
      onGameResumed();
      break;
    case MSG.RETURN_TO_LOBBY:
      if (music) music.stop();
      gameState = null;
      disconnectedQRs.clear();
      garbageIndicatorEffects.clear();
      showScreen('lobby');
      updateStartButton();
      break;
  }
}

// --- Tetris QR Helpers (standalone, renders to separate canvas) ---
function renderTetrisQR(canvas, qrMatrix) {
  if (!qrMatrix || !qrMatrix.modules) return;
  const { size, modules } = qrMatrix;

  const dpr = window.devicePixelRatio || 1;
  const cssSize = canvas.parentElement
    ? Math.min(canvas.parentElement.clientWidth, canvas.parentElement.clientHeight, 280)
    : 280;
  const cellPx = Math.floor((cssSize * dpr) / size);
  const totalPx = cellPx * size;

  canvas.width = totalPx;
  canvas.height = totalPx;
  canvas.style.width = (totalPx / dpr) + 'px';
  canvas.style.height = (totalPx / dpr) + 'px';

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, totalPx, totalPx);

  // White background
  ctx.fillStyle = THEME.color.text.white;
  ctx.fillRect(0, 0, totalPx, totalPx);

  const color = THEME.color.bg.card; // #12122a — dark navy from UI theme
  const inset = Math.max(0.5, cellPx * 0.03);
  const radius = Math.max(1, cellPx * 0.15);

  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const idx = row * size + col;
      const isDark = modules[idx] & 1;
      if (!isDark) continue;

      const x = col * cellPx;
      const y = row * cellPx;
      const s = cellPx;

      // Rounded rect with vertical gradient
      const grad = ctx.createLinearGradient(x, y, x, y + s);
      grad.addColorStop(0, lightenColor(color, 15));
      grad.addColorStop(1, darkenColor(color, 10));

      ctx.fillStyle = grad;
      roundRect(ctx, x + inset, y + inset, s - inset * 2, s - inset * 2, radius);
      ctx.fill();

      // Top highlight
      ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
      ctx.fillRect(x + inset + radius, y + inset, s - inset * 2 - radius * 2, Math.max(1, s * 0.08));

      // Left highlight
      ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
      ctx.fillRect(x + inset, y + inset + radius, Math.max(1, s * 0.07), s - inset * 2 - radius * 2);

      // Bottom shadow
      ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
      ctx.fillRect(x + inset + radius, y + s - inset - Math.max(1, s * 0.08), s - inset * 2 - radius * 2, Math.max(1, s * 0.08));

      // Inner shine
      ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
      const shineSize = s * 0.25;
      ctx.fillRect(x + s * 0.25, y + s * 0.2, shineSize, shineSize * 0.5);
    }
  }
}

function onRoomCreated(msg) {
  // Reset local state — new room has no players
  if (music) music.stop();
  players.clear();
  playerOrder = [];
  playerIndexCounter = 0;
  gameState = null;
  boardRenderers = [];
  uiRenderers = [];
  disconnectedQRs.clear();
  garbageIndicatorEffects.clear();

  lastRoomCode = msg.roomCode;
  joinUrlEl.textContent = msg.joinUrl;
  showScreen('lobby');
  updateStartButton();
  requestAnimationFrame(() => renderTetrisQR(qrCode, msg.qrMatrix));
}

function onPlayerJoined(msg) {
  const index = playerIndexCounter++;
  players.set(msg.playerId, {
    playerName: msg.playerName,
    playerColor: msg.playerColor,
    playerIndex: index
  });
  playerOrder.push(msg.playerId);
  updatePlayerList();
  updateStartButton();
}

function onPlayerLeft(msg) {
  players.delete(msg.playerId);
  playerOrder = playerOrder.filter(id => id !== msg.playerId);
  garbageIndicatorEffects.delete(msg.playerId);
  updatePlayerList();
  updateStartButton();
}

function onRoomReset() {
  if (music) music.stop();
  gameState = null;
  boardRenderers = [];
  uiRenderers = [];
  playerIndexCounter = 0;
  players.clear();
  playerOrder = [];
  garbageIndicatorEffects.clear();
  updatePlayerList();
  updateStartButton();
  showScreen('lobby');
}

function onCountdown(msg) {
  gameState = null;
  showScreen('game');
  countdownOverlay.classList.remove('hidden');
  countdownOverlay.textContent = msg.value;

  playCountdownBeep(msg.value === 'GO');

  if (msg.value === 'GO') {
    if (music && !music.playing) {
      music.start();
      if (muted) music.masterGain.gain.setValueAtTime(0, music.ctx.currentTime);
    }
    setTimeout(() => {
      countdownOverlay.classList.add('hidden');
      countdownOverlay.textContent = '';
    }, 400);
  }
}

function onGameState(msg) {
  gameState = msg;

  // Ensure player order matches game state players
  if (msg.players) {
    for (const p of msg.players) {
      if (!playerOrder.includes(p.id)) {
        playerOrder.push(p.id);
      }
    }
  }

  // Recalculate layout if renderers don't match player count
  if (msg.players && boardRenderers.length !== msg.players.length) {
    calculateLayout();
  }

  // Speed up music with the highest player level
  if (music && music.playing && msg.players && msg.players.length > 0) {
    const maxLevel = Math.max(...msg.players.map(p => p.level || 1));
    music.setSpeed(maxLevel);
  }
}

function onLineClear(msg) {
  if (!animations || !boardRenderers.length) return;
  const idx = playerOrder.indexOf(msg.playerId);
  if (idx < 0 || !boardRenderers[idx]) return;

  const br = boardRenderers[idx];
  const isTetris = msg.lines === 4;
  animations.addLineClear(
    br.x, br.y, br.cellSize,
    msg.rows || [], isTetris, msg.isTSpin
  );

  if (msg.combo >= 2) {
    animations.addCombo(
      br.x + br.boardWidth / 2,
      br.y + br.boardHeight / 2 - 30,
      msg.combo
    );
  }
}

function onGarbageSent(msg) {
  if (!animations || !boardRenderers.length) return;
  const idx = playerOrder.indexOf(msg.toId);
  if (idx < 0 || !boardRenderers[idx]) return;

  const br = boardRenderers[idx];
  const attackerColor = players.get(msg.senderId)?.playerColor || '#ffffff';
  animations.addGarbageShake(br.x, br.y);

  const shifted = (garbageIndicatorEffects.get(msg.toId) || [])
    .map((effect) => ({
      ...effect,
      rowStart: effect.rowStart - msg.lines
    }))
    .filter((effect) => effect.rowStart + effect.lines > 0);

  shifted.push({
    startTime: performance.now(),
    duration: 1000,
    maxAlpha: 0.94,
    color: attackerColor,
    lines: msg.lines,
    rowStart: Math.max(0, 20 - msg.lines)
  });

  garbageIndicatorEffects.set(msg.toId, shifted);
}

function onPlayerKO(msg) {
  if (!animations || !boardRenderers.length) return;
  const idx = playerOrder.indexOf(msg.playerId);
  if (idx < 0 || !boardRenderers[idx]) return;

  const br = boardRenderers[idx];
  animations.addKO(br.x, br.y, br.boardWidth, br.boardHeight);
}

function onGameEnd(msg) {
  if (music) music.stop();
  disconnectedQRs.clear();
  garbageIndicatorEffects.clear();
  showScreen('results');
  // Retrigger fade-in animation
  resultsScreen.style.animation = 'none';
  resultsScreen.offsetHeight;
  resultsScreen.style.animation = '';
  renderResults(msg.results);
}

function onPlayerDisconnected(msg) {
  if (msg.qrMatrix) {
    const offscreen = document.createElement('canvas');
    renderTetrisQR(offscreen, msg.qrMatrix);
    disconnectedQRs.set(msg.playerId, offscreen);
  } else {
    disconnectedQRs.set(msg.playerId, null);
  }
}

function onPlayerReconnected(msg) {
  disconnectedQRs.delete(msg.playerId);
}

// --- Lobby UI ---
const SLOT_LABELS = ['P1', 'P2', 'P3', 'P4'];
const MAX_SLOTS = 4;

function updatePlayerList() {
  // Create 4 permanent slot elements on first call
  if (playerListEl.children.length === 0) {
    for (let i = 0; i < MAX_SLOTS; i++) {
      const card = document.createElement('div');
      card.className = 'player-card empty';

      const name = document.createElement('span');
      name.textContent = SLOT_LABELS[i];

      card.appendChild(name);
      playerListEl.appendChild(card);
    }
  }

  // Reconcile each slot in place
  for (let i = 0; i < MAX_SLOTS; i++) {
    const card = playerListEl.children[i];
    const nameEl = card.querySelector('span');
    const playerId = playerOrder[i];
    const info = playerId ? players.get(playerId) : null;
    const wasEmpty = card.classList.contains('empty');

    if (info) {
      const color = info.playerColor || PLAYER_COLORS[info.playerIndex] || '#fff';
      card.style.setProperty('--player-color', color);
      nameEl.textContent = info.playerName || PLAYER_NAMES[info.playerIndex] || 'Player';
      card.classList.remove('empty');
      card.dataset.playerId = playerId;

      // Trigger join celebration only on empty-to-filled transition
      if (wasEmpty) {
        card.classList.remove('join-pop');
        void card.offsetWidth; // force reflow to restart animation
        card.classList.add('join-pop');
      }
    } else {
      card.style.removeProperty('--player-color');
      nameEl.textContent = SLOT_LABELS[i];
      card.classList.add('empty');
      card.classList.remove('join-pop');
      delete card.dataset.playerId;
    }
  }
}

function updateStartButton() {
  const hasPlayers = players.size > 0;
  startBtn.disabled = !hasPlayers;
  startBtn.textContent = hasPlayers
    ? `START (${players.size} player${players.size > 1 ? 's' : ''})`
    : 'Waiting for players...';
}

// Init music helper
function initMusic() {
  if (!music) {
    music = new Music();
  }
  music.init();
}

// Countdown beep using Web Audio API
function playCountdownBeep(isGo) {
  if (muted) return;
  if (!music || !music.ctx) return;
  const actx = music.ctx;
  if (actx.state === 'suspended') actx.resume();

  const osc = actx.createOscillator();
  const gain = actx.createGain();
  osc.connect(gain);
  gain.connect(actx.destination);

  if (isGo) {
    // Higher pitch, longer sweep for "GO"
    osc.type = 'square';
    osc.frequency.setValueAtTime(600, actx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1200, actx.currentTime + 0.15);
    gain.gain.setValueAtTime(0.18, actx.currentTime);
    gain.gain.linearRampToValueAtTime(0, actx.currentTime + 0.3);
    osc.start(actx.currentTime);
    osc.stop(actx.currentTime + 0.3);
  } else {
    // Short tick for 3, 2, 1
    osc.type = 'square';
    osc.frequency.value = 440;
    gain.gain.setValueAtTime(0.15, actx.currentTime);
    gain.gain.linearRampToValueAtTime(0, actx.currentTime + 0.12);
    osc.start(actx.currentTime);
    osc.stop(actx.currentTime + 0.12);
  }
}

// Welcome screen button: unlocks audio, enters fullscreen, connects, enters lobby
newGameBtn.addEventListener('click', () => {
  initMusic();
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  }
  connect();
  showScreen('lobby');
});

// Start button
startBtn.addEventListener('click', () => {
  if (startBtn.disabled) return;
  initMusic(); // safety net
  send(MSG.START_GAME);
});

// --- Results UI ---
function renderResults(results) {
  resultsList.innerHTML = '';
  if (!results) return;

  const sorted = [...results].sort((a, b) => a.rank - b.rank);

  // Set winner glow color from 1st-place player
  const winner = sorted[0];
  if (winner) {
    const wInfo = players.get(winner.playerId);
    const winnerColor = wInfo?.playerColor || PLAYER_COLORS[wInfo?.playerIndex] || '#ffd700';
    const r = parseInt(winnerColor.slice(1, 3), 16) || 255;
    const g = parseInt(winnerColor.slice(3, 5), 16) || 215;
    const b = parseInt(winnerColor.slice(5, 7), 16) || 0;
    resultsScreen.style.setProperty('--winner-glow', `rgba(${r}, ${g}, ${b}, 0.08)`);
  }

  const solo = sorted.length === 1;

  sorted.forEach((res, i) => {
    const row = document.createElement('div');
    row.className = solo ? 'result-row' : `result-row rank-${res.rank}`;
    row.style.setProperty('--row-delay', `${0.2 + i * 0.08}s`);

    if (!solo) {
      const rank = document.createElement('span');
      rank.className = 'result-rank';
      rank.textContent = res.rank <= 3 ? ['', '1st', '2nd', '3rd'][res.rank] : `${res.rank}th`;
      row.appendChild(rank);
    }

    const info = document.createElement('div');
    info.className = 'result-info';

    const nameEl = document.createElement('span');
    nameEl.className = 'result-name';
    const pInfo = players.get(res.playerId);
    nameEl.textContent = res.playerName || pInfo?.playerName || `Player ${res.playerId}`;
    if (pInfo) {
      nameEl.style.color = pInfo.playerColor || PLAYER_COLORS[pInfo.playerIndex];
    }

    const stats = document.createElement('div');
    stats.className = 'result-stats';
    stats.innerHTML = `<span>${(res.score || 0).toLocaleString()} points</span><span>${res.lines || 0} lines</span><span>Lv ${res.level || 1}</span>`;

    info.appendChild(nameEl);
    info.appendChild(stats);
    row.appendChild(info);
    resultsList.appendChild(row);
  });
}

// Play Again — restart with same players
playAgainBtn.addEventListener('click', () => {
  initMusic();
  send(MSG.PLAY_AGAIN);
});

// New Game — return to lobby so new players can join
newGameResultsBtn.addEventListener('click', () => {
  send(MSG.RETURN_TO_LOBBY);
});

// --- Mute ---
muteBtn.addEventListener('click', () => {
  muted = !muted;
  muteBtn.querySelector('.sound-waves').style.display = muted ? 'none' : '';
  if (music && music.masterGain) {
    music.masterGain.gain.cancelScheduledValues(music.ctx.currentTime);
    music.masterGain.gain.setValueAtTime(music.masterGain.gain.value, music.ctx.currentTime);
    music.masterGain.gain.linearRampToValueAtTime(muted ? 0 : 0.12, music.ctx.currentTime + 0.05);
  }
});

// --- Fullscreen ---
fullscreenBtn.addEventListener('click', () => {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen().catch(() => {});
  }
});

// --- Pause ---
function onGamePaused() {
  pauseOverlay.classList.remove('hidden');
  gameToolbar.classList.add('hidden');
  if (music) music.stop();
}

function onGameResumed() {
  pauseOverlay.classList.add('hidden');
  if (currentScreen === 'game') {
    gameToolbar.classList.remove('hidden');
  }
  // If paused mid-countdown, the overlay still has content — show it again
  if (countdownOverlay.textContent) {
    countdownOverlay.classList.remove('hidden');
  } else if (music) {
    // Only restart music when resuming actual gameplay, not mid-countdown
    music.start();
    if (muted) music.masterGain.gain.setValueAtTime(0, music.ctx.currentTime);
  }
}

pauseBtn.addEventListener('click', () => {
  send(MSG.PAUSE_GAME);
});

pauseContinueBtn.addEventListener('click', () => {
  send(MSG.RESUME_GAME);
});

pauseNewGameBtn.addEventListener('click', () => {
  send(MSG.RETURN_TO_LOBBY);
});

// --- Render Loop ---
function renderLoop(timestamp) {
  requestAnimationFrame(renderLoop);

  if ((currentScreen !== 'game' && currentScreen !== 'results') || !ctx) return;

  if (lastFrameTime === null) lastFrameTime = timestamp;
  const deltaMs = timestamp - lastFrameTime;
  lastFrameTime = timestamp;

  // Clear canvas — deep space background with subtle radial vignette
  const w = window.innerWidth;
  const h = window.innerHeight;
  ctx.fillStyle = THEME.color.bg.primary;
  ctx.fillRect(0, 0, w, h);

  // Subtle vignette (cached)
  if (!renderLoop._vignette || renderLoop._vw !== w || renderLoop._vh !== h) {
    renderLoop._vignette = ctx.createRadialGradient(w / 2, h / 2, h * 0.2, w / 2, h / 2, h * 0.8);
    renderLoop._vignette.addColorStop(0, 'rgba(15, 15, 40, 0.3)');
    renderLoop._vignette.addColorStop(1, 'rgba(0, 0, 0, 0.4)');
    renderLoop._vw = w;
    renderLoop._vh = h;
  }
  ctx.fillStyle = renderLoop._vignette;
  ctx.fillRect(0, 0, w, h);

  // No game state yet (e.g. during countdown) — render empty boards
  if (!gameState) {
    for (let i = 0; i < playerOrder.length; i++) {
      if (!boardRenderers[i] || !uiRenderers[i]) continue;
      const pInfo = players.get(playerOrder[i]);
      const empty = {
        id: playerOrder[i],
        alive: true,
        score: 0,
        lines: 0,
        level: 1,
        garbageIndicatorEffects: [],
        playerName: pInfo?.playerName || PLAYER_NAMES[i],
        playerColor: pInfo?.playerColor || PLAYER_COLORS[i]
      };
      boardRenderers[i].render(empty);
      uiRenderers[i].render(empty);
    }
    return;
  }

  // Render each player
  if (gameState.players) {
    for (let i = 0; i < gameState.players.length; i++) {
      const playerData = gameState.players[i];
      if (!boardRenderers[i] || !uiRenderers[i]) continue;

      // Apply shake offset if active
      const shake = animations
        ? animations.getShakeOffsetForBoard(boardRenderers[i].x, boardRenderers[i].y)
        : { x: 0, y: 0 };

      if (shake.x !== 0 || shake.y !== 0) {
        ctx.save();
        ctx.translate(shake.x, shake.y);
      }

      // Augment player data with name info from our players map
      const pInfo = players.get(playerData.id);
      const now = performance.now();
      const activeGarbageIndicatorEffects = (garbageIndicatorEffects.get(playerData.id) || [])
        .filter((effect) => now - effect.startTime < effect.duration);
      if (activeGarbageIndicatorEffects.length > 0) {
        garbageIndicatorEffects.set(playerData.id, activeGarbageIndicatorEffects);
      } else {
        garbageIndicatorEffects.delete(playerData.id);
      }
      const enriched = {
        ...playerData,
        garbageIndicatorEffects: activeGarbageIndicatorEffects,
        playerName: pInfo?.playerName || PLAYER_NAMES[i],
        playerColor: pInfo?.playerColor || PLAYER_COLORS[i]
      };

      boardRenderers[i].render(enriched);
      uiRenderers[i].render(enriched);

      // Draw QR overlay for disconnected players
      if (disconnectedQRs.has(playerData.id)) {
        const br = boardRenderers[i];
        const bx = br.x;
        const by = br.y;
        const bw = 10 * br.cellSize;
        const bh = 20 * br.cellSize;

        // Semi-transparent dark overlay
        ctx.fillStyle = `rgba(0, 0, 0, ${THEME.opacity.overlay})`;
        ctx.fillRect(bx, by, bw, bh);

        const qrImg = disconnectedQRs.get(playerData.id);
        const labelSize = Math.max(10, br.cellSize * THEME.font.cellScale.name);
        const labelGap = labelSize * 1.2;
        const qrSize = Math.min(bw, bh) * 0.5;
        const radius = qrSize * 0.08;
        const pad = qrSize * 0.06;
        const outerSize = qrSize + pad * 2;
        // Center QR + label group vertically
        const totalH = outerSize + labelGap + labelSize;
        const groupY = by + (bh - totalH) / 2;
        const outerX = bx + (bw - outerSize) / 2;
        const outerY = groupY;

        // Rounded white background (matches lobby QR style)
        ctx.fillStyle = THEME.color.text.white;
        ctx.beginPath();
        ctx.roundRect(outerX, outerY, outerSize, outerSize, radius);
        ctx.fill();

        // Subtle border
        ctx.strokeStyle = 'rgba(0, 200, 255, 0.15)';
        ctx.lineWidth = 1;
        ctx.stroke();

        // Draw QR image clipped to rounded rect
        if (qrImg) {
          ctx.save();
          ctx.beginPath();
          ctx.roundRect(outerX + pad, outerY + pad, qrSize, qrSize, Math.max(1, radius - pad));
          ctx.clip();
          ctx.drawImage(qrImg, outerX + pad, outerY + pad, qrSize, qrSize);
          ctx.restore();
        }

        // "Scan to rejoin" label directly below QR (in player color)
        ctx.fillStyle = enriched.playerColor || 'rgba(0, 200, 255, 0.7)';
        ctx.font = `600 ${labelSize}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.letterSpacing = '0.1em';
        ctx.fillText('SCAN TO REJOIN', bx + bw / 2, outerY + outerSize + labelGap);
        ctx.letterSpacing = '0px';
      }

      if (shake.x !== 0 || shake.y !== 0) {
        ctx.restore();
      }
    }
  }

  // Update and render animations
  if (animations) {
    animations.update(deltaMs);
    animations.render();
  }

  // Draw game timer
  if (gameState.elapsed != null) {
    drawTimer(gameState.elapsed);
  }
}

let _timerFontReady = false;
function drawTimer(elapsedMs) {
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const timeStr = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

  if (!_timerFontReady) {
    _timerFontReady = document.fonts?.check?.('14px Orbitron') ?? false;
  }
  const font = _timerFontReady ? 'Orbitron' : '"Courier New", monospace';

  // Size to match toolbar button height: clamp(36px, 4vh, 52px)
  const btnH = Math.min(52, Math.max(36, window.innerHeight * 0.04));
  const labelSize = Math.round(btnH * 0.6);
  const digitAdvance = labelSize * 0.92;
  const colonAdvance = labelSize * 0.52;
  const advances = [];
  let timerWidth = 0;
  for (let i = 0; i < timeStr.length; i++) {
    const advance = timeStr[i] === ':' ? colonAdvance : digitAdvance;
    advances.push(advance);
    timerWidth += advance;
  }
  const startX = window.innerWidth / 2 - timerWidth / 2;
  // Vertically center with toolbar buttons: top offset + half button height
  const btnTop = Math.min(20, Math.max(10, window.innerHeight * 0.015));
  const y = btnTop + (btnH - labelSize) / 2;

  ctx.fillStyle = `rgba(255, 255, 255, ${THEME.opacity.label})`;
  ctx.font = `700 ${labelSize}px ${font}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.letterSpacing = '0.15em';
  let cursorX = startX;
  for (let i = 0; i < timeStr.length; i++) {
    const charX = cursorX + advances[i] / 2;
    ctx.fillText(timeStr[i], charX, y);
    cursorX += advances[i];
  }
  ctx.letterSpacing = '0px';
}

// --- Cursor Auto-Hide ---
let cursorTimer = null;
function showCursor() {
  document.body.classList.remove('cursor-hidden');
  clearTimeout(cursorTimer);
  cursorTimer = setTimeout(() => {
    document.body.classList.add('cursor-hidden');
  }, 3000);
}
document.addEventListener('mousemove', showCursor);
showCursor();

// --- Window Resize ---
window.addEventListener('resize', () => {
  resizeCanvas();
  if (welcomeBg) welcomeBg.resize(window.innerWidth, window.innerHeight);
});

// --- Initialize ---
// Fetch and display version
fetch('/api/version').then(r => r.json()).then(data => {
  document.getElementById('version-label').textContent = `v${data.version}`;
}).catch(() => {});

// Falling tetromino background (shared across welcome + lobby screens)
const bgCanvas = document.getElementById('bg-canvas');
if (bgCanvas) {
  welcomeBg = new WelcomeBackground(bgCanvas);
  welcomeBg.resize(window.innerWidth, window.innerHeight);
  welcomeBg.start();
}

requestAnimationFrame(renderLoop);
