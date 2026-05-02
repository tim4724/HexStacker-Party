'use strict';

// =====================================================================
// Display UI — layout calculation, lobby UI, QR rendering, timer
// Depends on: DisplayState.js (globals)
// Called by: DisplayConnection.js, DisplayGame.js, display.js
// =====================================================================

// Build the static "LEVEL" pill shown beneath the player name. The value
// span starts empty; updatePlayerList writes the player's startLevel into
// it when the slot fills, and clears it when the slot empties.
function buildCardLevelLabel() {
  var lvl = document.createElement('div');
  lvl.className = 'card-level';
  // Static scaffold — translated string injected via textContent below.
  lvl.innerHTML = '<span class="card-level__heading"></span><span class="card-level__value"></span>';
  lvl.querySelector('.card-level__heading').textContent = t('level_heading');
  return lvl;
}

// --- Layout Calculation ---
function calculateLayout() {
  if (!ctx || playerOrder.length === 0) return;
  // Sort by join time so board positions are stable across color changes
  // and sticky-host behavior — first joiner is leftmost, last joiner
  // rightmost, color pick has no effect on seat.
  playerOrder.sort(function(a, b) {
    return (players.get(a)?.joinedAt ?? Infinity) - (players.get(b)?.joinedAt ?? Infinity);
  });
  clearStampCache();

  var n = playerOrder.length;
  var w = window.innerWidth;
  var h = window.innerHeight;
  var padding = THEME.size.canvasPad;
  var boardCols = GameConstants.COLS;
  var hexRows = GameConstants.VISIBLE_ROWS;
  var boardRows = GameConstants.computeHexGeometry(boardCols, hexRows, 1).boardHeight;
  var totalCellsWide = boardCols + 3 + 3;
  // Gaps scale with cellSize to stay proportional at all zoom levels
  function nameGap(cs) { return cs * 0.6; }
  var font = getDisplayFont();

  var _measureCache = {};
  function measureHeight(weight, size) {
    var key = weight + '_' + size;
    if (_measureCache[key] != null) return _measureCache[key];
    ctx.font = weight + ' ' + size + 'px ' + font;
    var m = ctx.measureText('Mg');
    var h = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
    _measureCache[key] = h;
    return h;
  }

  function textHeight(cs) {
    var nameSize = Math.max(THEME.font.minPx.name, cs * THEME.font.cellScale.name);
    return measureHeight(700, nameSize) + nameGap(cs);
  }

  function cellSizeFor(cols, rows) {
    var aw = (w - padding * (cols + 1)) / cols;
    var ah = (h - padding * (rows + 1)) / rows;
    var cs = Math.floor(Math.min(aw / totalCellsWide, ah / boardRows));
    while (cs > 1 && cs * boardRows + textHeight(cs) > ah) cs--;
    return cs;
  }

  var gridCols, gridRows, cellSize;
  if (n === 1) { gridCols = 1; gridRows = 1; }
  else if (n === 2) { gridCols = 2; gridRows = 1; }
  else if (n === 3) { gridCols = 3; gridRows = 1; }
  else if (n <= 4) {
    var cs4x1 = cellSizeFor(4, 1), cs2x2 = cellSizeFor(2, 2);
    if (cs4x1 >= cs2x2) { gridCols = 4; gridRows = 1; cellSize = cs4x1; }
    else { gridCols = 2; gridRows = 2; cellSize = cs2x2; }
  } else if (n <= 6) {
    var csN = cellSizeFor(n, 1), cs3x2 = cellSizeFor(3, 2);
    if (csN >= cs3x2) { gridCols = n; gridRows = 1; cellSize = csN; }
    else { gridCols = 3; gridRows = 2; cellSize = cs3x2; }
  } else {
    var csNw = cellSizeFor(n, 1), cs4x2 = cellSizeFor(4, 2);
    if (csNw >= cs4x2) { gridCols = n; gridRows = 1; cellSize = csNw; }
    else { gridCols = 4; gridRows = 2; cellSize = cs4x2; }
  }
  if (!cellSize) cellSize = cellSizeFor(gridCols, gridRows);
  var geo = GameConstants.computeHexGeometry(boardCols, hexRows, cellSize);
  var boardWidthPx = geo.boardWidth;
  var boardHeightPx = geo.boardHeight;

  boardRenderers = [];
  uiRenderers = [];
  if (!animations) {
    animations = new Animations(ctx);
  } else {
    animations.active = [];
  }

  var maxSlots = gridCols * gridRows;
  var cellAreaW = (w - padding * (gridCols + 1)) / gridCols;
  var cellAreaH = (h - padding * (gridRows + 1)) / gridRows;
  var nameSize = Math.max(THEME.font.minPx.name, cellSize * THEME.font.cellScale.name);
  var nameArea = measureHeight(700, nameSize) + nameGap(cellSize);
  var totalContentH = boardHeightPx + textHeight(cellSize);

  for (var i = 0; i < n && i < maxSlots; i++) {
    var col = i % gridCols;
    var row = Math.floor(i / gridCols);
    var boardX = padding + col * (cellAreaW + padding) + (cellAreaW - boardWidthPx) / 2;
    var boardY = padding + row * (cellAreaH + padding) + (cellAreaH - totalContentH) / 2 + nameArea;
    var playerIndex = players.get(playerOrder[i])?.playerIndex ?? i;
    boardRenderers.push(new BoardRenderer(ctx, boardX, boardY, cellSize, playerIndex));
    uiRenderers.push(new UIRenderer(ctx, boardX, boardY, cellSize, boardWidthPx, boardHeightPx, playerIndex));
  }
}

// --- Lobby UI ---
function updatePlayerList() {
  var placeholderSlots = window.innerWidth >= 2400 ? 8 : 4;
  var totalSlots = Math.max(placeholderSlots, GameConstants.MAX_PLAYERS);

  // Ensure we have enough slot elements
  while (playerListEl.children.length < totalSlots) {
    var slot = document.createElement('div');
    slot.className = 'player-slot';
    var card = document.createElement('div');
    card.className = 'player-card empty';
    var topRow = document.createElement('div');
    topRow.className = 'player-card__top';
    var name = document.createElement('span');
    name.className = 'identity-name';
    var idx = playerListEl.children.length;
    name.textContent = 'P' + (idx + 1);
    topRow.appendChild(name);
    card.appendChild(topRow);
    card.appendChild(buildCardLevelLabel());
    slot.appendChild(card);
    playerListEl.appendChild(slot);
  }

  // Cards pack tightly: N players fill the first N slots. Ordering follows
  // join time so a player's seat is stable across color changes — color
  // picks recolor the card in place rather than swapping slots with a
  // neighbor. Same rule used by calculateLayout() for the game boards.
  var sortedPlayers = Array.from(players.entries()).sort(function(a, b) {
    return (a[1].joinedAt ?? Infinity) - (b[1].joinedAt ?? Infinity);
  });
  var visibleSlots = Math.max(placeholderSlots, sortedPlayers.length);

  // In AirConsole empty slots are hidden, so the layout bucket is driven by
  // actual player count; elsewhere use the visible-slot count (incl. placeholders).
  // 5+ players get a wider 4-column grid in landscape via the .pl--lg rule.
  var isAirConsole = document.body.classList.contains('airconsole');
  var bucketCount = isAirConsole ? players.size : visibleSlots;
  playerListEl.classList.toggle('pl--lg', bucketCount > 4);

  for (var j = 0; j < totalSlots; j++) {
    var slot = playerListEl.children[j];
    var card = slot.querySelector('.player-card');
    var nameEl = card.querySelector('.identity-name');
    var levelValueEl = card.querySelector('.card-level__value');

    // Hide slots beyond visible range
    slot.style.display = j < visibleSlots ? '' : 'none';

    // Nth filled slot gets the Nth player from the join-sorted list.
    var playerId = null;
    var info = null;
    if (j < sortedPlayers.length) {
      playerId = sortedPlayers[j][0];
      info = sortedPlayers[j][1];
    }
    var wasEmpty = card.classList.contains('empty');

    if (info) {
      var color = PLAYER_COLORS[info.playerIndex] || '#fff';
      var lvl = info.startLevel || 1;
      card.style.setProperty('--player-color', color);
      nameEl.textContent = info.playerName || PLAYER_NAMES[info.playerIndex] || t('player');
      card.classList.remove('empty');
      card.dataset.playerId = playerId;
      slot.dataset.playerId = playerId;
      if (wasEmpty) {
        card.classList.remove('join-pop');
        void card.offsetWidth;
        card.classList.add('join-pop');
      }
      levelValueEl.textContent = lvl;
    } else {
      card.style.removeProperty('--player-color');
      nameEl.textContent = 'P' + (j + 1);
      card.classList.add('empty');
      card.classList.remove('join-pop');
      delete card.dataset.playerId;
      delete slot.dataset.playerId;
      // Empty slots: leave the value blank so the placeholder reads
      // just "LEVEL" rather than a stale "1" from before the player joined.
      levelValueEl.textContent = '';
    }
  }
}

function updateStartButton() {
  var hasPlayers = players.size > 0;
  startBtn.disabled = !hasPlayers;
  startBtn.textContent = hasPlayers
    ? t('start_n_players', { count: players.size })
    : t('waiting_for_players');
  applyHostTint();
}

// Tint primary CTAs (lobby start + pause/reconnect/results overlays) with the
// current host's identity color. Setting on <body> lets every tinted button in
// theme.css inherit without per-button wiring. Shared rule reads
// --player-color, falling back to --accent-primary when unset. Called both
// from the lobby flow (updateStartButton) and from broadcastLobbyUpdate so a
// mid-game host handoff (AirConsole master_changed, player leaving during
// RESULTS) refreshes the tint on the pause/results/reconnect overlays too.
function applyHostTint() {
  var hostId = getHostClientId();
  var hostPlayer = hostId ? players.get(hostId) : null;
  var hostColor = hostPlayer ? PLAYER_COLORS[hostPlayer.playerIndex] : null;
  if (hostColor) {
    document.body.style.setProperty('--player-color', hostColor);
  } else {
    document.body.style.removeProperty('--player-color');
  }
}

// --- QR Code Rendering ---
function renderQR(canvas, qrMatrix, targetCssSize) {
  if (!qrMatrix || !qrMatrix.modules) return;
  var size = qrMatrix.size;
  var modules = qrMatrix.modules;

  var dpr = window.devicePixelRatio || 1;
  var rect = canvas.getBoundingClientRect();
  var cssSize = targetCssSize || Math.min(rect.width, rect.height) || 180;
  var cellPx = Math.floor((cssSize * dpr) / size);
  var totalPx = cellPx * size;

  canvas.width = totalPx;
  canvas.height = totalPx;

  var qrCtx = canvas.getContext('2d');
  qrCtx.clearRect(0, 0, totalPx, totalPx);

  qrCtx.fillStyle = THEME.color.text.white;
  qrCtx.fillRect(0, 0, totalPx, totalPx);

  var inset = Math.max(0.5, cellPx * 0.03);
  var radius = Math.max(1, cellPx * 0.15);

  qrCtx.fillStyle = THEME.color.bg.card;
  for (var row = 0; row < size; row++) {
    for (var col = 0; col < size; col++) {
      var idx = row * size + col;
      if (!(modules[idx] & 1)) continue;

      var x = col * cellPx + inset;
      var y = row * cellPx + inset;
      var s = cellPx - inset * 2;

      roundRect(qrCtx, x, y, s, s, radius);
      qrCtx.fill();
    }
  }
}

// --- Results Rendering ---
function renderResults(results) {
  resultsList.innerHTML = '';
  if (!results) return;

  var sorted = results.slice().sort(function(a, b) { return a.rank - b.rank; });

  var winner = sorted[0];
  if (winner) {
    var wInfo = players.get(winner.playerId);
    var winnerColor = (wInfo && PLAYER_COLORS[wInfo.playerIndex]) || '#ffd700';
    resultsScreen.style.setProperty('--winner-glow', rgbaFromHex(winnerColor, 0.08));
  }

  var solo = sorted.length === 1;

  for (var i = 0; i < sorted.length; i++) {
    var res = sorted[i];
    var row = document.createElement('div');
    row.className = solo ? 'result-row' : 'result-row rank-' + res.rank;
    row.style.setProperty('--row-delay', (0.2 + i * 0.08) + 's');

    var pInfo = players.get(res.playerId);
    var pColor = pInfo ? PLAYER_COLORS[pInfo.playerIndex] : null;

    if (!solo) {
      var rank = document.createElement('span');
      rank.className = 'result-rank';
      rank.textContent = String(res.rank);
      if (pColor) rank.style.color = pColor;
      row.appendChild(rank);
    }

    var info = document.createElement('div');
    info.className = 'result-info';

    var nameEl = document.createElement('span');
    nameEl.className = 'result-name';
    nameEl.textContent = res.playerName || pInfo?.playerName || t('player');
    if (pColor) nameEl.style.color = pColor;

    var stats = document.createElement('div');
    stats.className = 'result-stats';
    var linesSpan = document.createElement('span');
    linesSpan.textContent = t('n_lines', { count: res.lines || 0 });
    var levelSpan = document.createElement('span');
    levelSpan.textContent = t('level_n', { level: res.level || 1 });
    stats.appendChild(linesSpan);
    stats.appendChild(levelSpan);

    info.appendChild(nameEl);
    info.appendChild(stats);
    row.appendChild(info);
    resultsList.appendChild(row);
  }
}

// --- Timer Rendering ---
function drawTimer(elapsedMs) {
  var totalSeconds = Math.floor(elapsedMs / 1000);
  var minutes = Math.floor(totalSeconds / 60);
  var seconds = totalSeconds % 60;
  var timeStr = String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');

  var font = getDisplayFont();
  var cs = (boardRenderers.length > 0 ? boardRenderers[0].cellSize : 30);
  var timerSize = Math.max(THEME.font.minPx.timer, cs * THEME.font.cellScale.timer);

  var labelSize = Math.round(timerSize);
  var digitAdvance = labelSize * 0.92;
  var colonAdvance = labelSize * 0.52;
  var advances = [];
  var timerWidth = 0;
  for (var i = 0; i < timeStr.length; i++) {
    var advance = timeStr[i] === ':' ? colonAdvance : digitAdvance;
    advances.push(advance);
    timerWidth += advance;
  }
  // With odd board counts the centre board's stats text overlaps a centred timer,
  // so anchor the timer to the left edge of the screen instead.
  var n = boardRenderers.length;
  var startX;
  if (n > 0 && n % 2 === 1) {
    startX = THEME.size.canvasPad + timerSize * 0.3;
  } else {
    startX = cachedW / 2 - timerWidth / 2;
  }
  var btnTop = timerSize * 0.6;
  var y = btnTop;

  ctx.fillStyle = 'rgba(255, 255, 255, ' + THEME.opacity.label + ')';
  ctx.font = '700 ' + labelSize + 'px ' + font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.letterSpacing = '0.15em';
  var cursorX = startX;
  for (var k = 0; k < timeStr.length; k++) {
    var charX = cursorX + advances[k] / 2;
    ctx.fillText(timeStr[k], charX, y);
    cursorX += advances[k];
  }
  ctx.letterSpacing = '0px';
}
