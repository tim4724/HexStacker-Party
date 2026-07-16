'use strict';

// =====================================================================
// Display Render — RAF render loop management
// Depends on: DisplayState.js, DisplayUI.js, Animations.js
// =====================================================================

// Cap frame delta to ~3 frames at 60Hz — prevents huge catch-up jumps after tab unfreeze.
// Sourced from the shared constants module (PartyCore's native frame() cap reads the same), so they can't drift.
var MAX_FRAME_DELTA_MS = GameConstants.MAX_FRAME_DELTA_MS;
// ~4fps — used when paused/results and no active animations, to save battery.
var IDLE_FRAME_INTERVAL_MS = 250;

var lastThrottled = null;
var _NO_SHAKE = Object.freeze({ x: 0, y: 0 });

// Scene signature of the last painted frame. Pieces move in discrete grid
// cells (no sub-row interpolation), so most RAF frames during play are
// pixel-identical to the previous one: when the signature matches and no
// time-driven effect is animating, the repaint is skipped entirely.
// null = unknown/stale (always repaint next frame).
var lastRenderSig = null;

// Called whenever the canvas content is externally invalidated (layout
// recalculation, canvas resize; assigning canvas.width clears the canvas).
function invalidateRenderSig() {
  lastRenderSig = null;
}

// Everything renderFrame draws must be reflected here; a missed input means
// a skipped repaint after that input changes. Time-driven visuals (near-clear
// pulse, clearing glow, sparkles, garbage effects) are excluded on purpose:
// renderLoop treats those as "must animate" and bypasses the signature check.
function computeRenderSig() {
  // Font families flip when the webfonts finish loading (UIRenderer rebuilds
  // its cached font strings on the next paint), so they must repaint too.
  var sig = currentScreen + '|' + boardRenderers.length + '|'
    + getDisplayFont() + '|' + getBrandFont();
  if (!gameState) {
    sig += '|empty';
    for (var i = 0; i < playerOrder.length; i++) {
      var pInfo = players.get(playerOrder[i]);
      sig += '|' + playerOrder[i] + ':'
        + (pInfo ? pInfo.playerName + ':' + pInfo.playerIndex + ':' + (pInfo.startLevel || 1) : '');
    }
    return sig;
  }
  sig += '|' + (gameState.elapsed != null ? Math.floor(gameState.elapsed / 1000) : -1);
  var ps = gameState.players;
  if (ps) {
    for (var j = 0; j < ps.length; j++) {
      var p = ps[j];
      var pInfo = players.get(p.id);
      // 0 = connected, 1 = disconnected (QR still generating), 2 = QR ready;
      // the async QR arrival must trigger a repaint.
      var qr = disconnectedQRs.has(p.id) ? (disconnectedQRs.get(p.id) ? 2 : 1) : 0;
      sig += '|' + p.id + ':' + (p.alive ? 1 : 0) + ':' + p.lines + ':' + p.level
        + ':' + p.pendingGarbage + ':' + p.gridVersion + ':' + (p.holdPiece || '')
        + ':' + qr + ':' + (pInfo ? pInfo.playerName + ':' + pInfo.playerIndex : '');
      var cp = p.currentPiece;
      // cells[0] uniquely identifies rotation for every hex piece type (same
      // invariant the clear-preview cache in BoardRenderer relies on).
      if (cp) sig += ':' + cp.typeId + ':' + cp.anchorCol + ':' + cp.anchorRow
        + ':' + cp.cells[0].q + ':' + cp.cells[0].r;
    }
  }
  return sig;
}

// Returns all effects if any is still active; otherwise clears the map entry and returns [].
var _EMPTY_EFFECTS = Object.freeze([]);
function getOrClearEffects(effectsMap, playerId, timestamp) {
  var effects = effectsMap.get(playerId);
  if (!effects) return _EMPTY_EFFECTS;
  for (var i = 0; i < effects.length; i++) {
    if (timestamp - effects[i].startTime < effects[i].duration) return effects;
  }
  effectsMap.delete(playerId);
  return _EMPTY_EFFECTS;
}

function startRenderLoop() {
  if (rafId != null) return;
  rafId = requestAnimationFrame(renderLoop);
}

function stopRenderLoop() {
  if (rafId != null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function renderLoop(timestamp) {
  if (rafId == null) return;
  rafId = requestAnimationFrame(renderLoop);

  if ((currentScreen !== SCREEN.GAME && currentScreen !== SCREEN.RESULTS) || !ctx) return;

  // Drive game physics from RAF
  if (displayGame && roomState === ROOM_STATE.PLAYING && !paused) {
    var deltaMs = prevFrameTime ? Math.min(timestamp - prevFrameTime, MAX_FRAME_DELTA_MS) : 0;
    try {
      if (deltaMs > 0) {
        displayGame.update(deltaMs);
      }
      if (!displayGame) return; // game ended during update
      gameState = displayGame.getSnapshot();
    } catch (err) {
      console.error('Game engine error:', err);
      if (!displayGame) return;  // already cleaned up (e.g. game ended mid-update)
      displayGame.ended = true;
      var results = displayGame.getResults();
      displayGame = null;
      prevFrameTime = 0;
      if (results) {
        setRoomState(ROOM_STATE.RESULTS);
        lastResults = results;
        party.broadcast({ type: MSG.GAME_END, elapsed: results.elapsed, results: results.results });
        onGameEnd(results);
      }
      return;
    }

    // Recalculate layout if player count changed
    if (gameState.players && boardRenderers.length !== gameState.players.length) {
      calculateLayout();
    }

    prevFrameTime = timestamp;
  } else {
    prevFrameTime = 0;
    // Prime one static snapshot if the game paused before the loop ever
    // captured one (e.g. sole controller dropped during countdown, so PLAYING
    // begins already auto-paused). Without it gameState stays null and the
    // disconnect overlay never renders over the empty pre-game boards.
    if (displayGame && roomState === ROOM_STATE.PLAYING && gameState === null) {
      try {
        gameState = displayGame.getSnapshot();
      } catch (err) {
        console.error('Game engine error:', err);
        displayGame = null;
      }
    }
  }

  // Throttle to ~4fps when paused/results with no active animations
  var hasAnimations = animations && animations.active.length > 0;
  var hasGarbageEffects = garbageIndicatorEffects.size > 0 || garbageDefenceEffects.size > 0;
  if ((paused || currentScreen === SCREEN.RESULTS) && !hasAnimations && !hasGarbageEffects) {
    if (!lastThrottled) lastThrottled = timestamp;
    if (timestamp - lastThrottled < IDLE_FRAME_INTERVAL_MS) return;
    lastThrottled = timestamp;
  } else {
    lastThrottled = null;
  }

  // Skip the repaint when the scene is provably identical to the last painted
  // frame. Time-driven effects (sparkles, garbage flashes, clearing glow,
  // near-clear pulse) animate against the clock, so any of them being active
  // forces a paint; the near-clear check reads the renderers' cached cells
  // from the previous paint, which stay valid while gridVersion is unchanged.
  // window.__TEST__ (e2e/gallery/adclip) disables skipping so captures see
  // every frame.
  var mustAnimate = hasAnimations || hasGarbageEffects || !!window.__TEST__;
  if (!mustAnimate && gameState && gameState.players) {
    for (var mi = 0; mi < gameState.players.length; mi++) {
      var mp = gameState.players[mi];
      if (mp.clearingCells && mp.clearingCells.length > 0) { mustAnimate = true; break; }
      if (boardRenderers[mi] && boardRenderers[mi]._cachedNcCells.length > 0) { mustAnimate = true; break; }
    }
  }
  if (mustAnimate) {
    lastRenderSig = null;
  } else {
    var sig = computeRenderSig();
    if (sig === lastRenderSig) return;
    lastRenderSig = sig;
  }

  try {
    renderFrame(timestamp);
  } catch (err) {
    console.error('[render] Error in render loop:', err);
  }
}

function renderFrame(timestamp) {
  var w = cachedW;
  var h = cachedH;
  ctx.fillStyle = THEME.color.bg.primary;
  ctx.fillRect(0, 0, w, h);

  if (!gameState) {
    for (var i = 0; i < playerOrder.length; i++) {
      if (!boardRenderers[i] || !uiRenderers[i]) continue;
      var pInfo = players.get(playerOrder[i]);
      var empty = {
        id: playerOrder[i],
        alive: true,
        lines: 0, level: pInfo?.startLevel || 1,
        garbageIndicatorEffects: _EMPTY_EFFECTS,
        garbageDefenceEffects: _EMPTY_EFFECTS,
        playerName: pInfo?.playerName || PLAYER_NAMES[i],
        playerColor: PLAYER_COLORS[pInfo?.playerIndex ?? i]
      };
      boardRenderers[i].render(empty);
      uiRenderers[i].render(empty);
    }
    return;
  }

  if (gameState.players) {
    for (var j = 0; j < gameState.players.length; j++) {
      var playerData = gameState.players[j];
      if (!boardRenderers[j] || !uiRenderers[j]) continue;

      var shake = animations
        ? animations.getShakeOffsetForBoard(boardRenderers[j].x, boardRenderers[j].y)
        : _NO_SHAKE;

      if (shake.x !== 0 || shake.y !== 0) {
        ctx.save();
        ctx.translate(shake.x, shake.y);
      }

      var pInfo = players.get(playerData.id);
      var activeGarbageIndicatorEffects = getOrClearEffects(garbageIndicatorEffects, playerData.id, timestamp);
      var activeGarbageDefenceEffects = getOrClearEffects(garbageDefenceEffects, playerData.id, timestamp);
      // playerData contains live references (blocks, cells, grid rows) —
      // consume within this frame. Mutating here avoids Object.assign overhead.
      playerData.garbageIndicatorEffects = activeGarbageIndicatorEffects;
      playerData.garbageDefenceEffects = activeGarbageDefenceEffects;
      playerData.playerName = pInfo?.playerName || PLAYER_NAMES[j];
      playerData.playerColor = PLAYER_COLORS[pInfo?.playerIndex ?? j];

      boardRenderers[j].render(playerData, timestamp);
      uiRenderers[j].render(playerData, timestamp);

      // Test-only: draw extra ghost pieces if set
      if (window.__TEST__ && window.__TEST__._extraGhosts && window.__TEST__._extraGhosts[j]) {
        var br = boardRenderers[j];
        var extras = window.__TEST__._extraGhosts[j];
        for (var eg = 0; eg < extras.length; eg++) {
          var ghost = extras[eg];
          var gc = GHOST_COLORS[ghost.typeId] || { outline: 'rgba(255,255,255,0.12)', fill: 'rgba(255,255,255,0.06)' };
          if (ghost.blocks) {
            for (var bl = 0; bl < ghost.blocks.length; bl++) {
              var gbx = ghost.blocks[bl][0];
              var gby = ghost.blocks[bl][1];
              var drawCol = ghost.x + gbx;
              var drawRow = ghost.ghostY + gby;
              br.drawGhostBlock(drawCol, drawRow, gc);
            }
          }
        }
      }

      // Draw QR overlay for disconnected players
      if (disconnectedQRs.has(playerData.id)) {
        uiRenderers[j].drawDisconnectedOverlay(
          disconnectedQRs.get(playerData.id),
          playerData.playerColor
        );
      }

      if (shake.x !== 0 || shake.y !== 0) {
        ctx.restore();
      }
    }
  }

  if (animations) {
    animations.update(timestamp);
    animations.render(timestamp);
  }

  if (gameState.elapsed != null) {
    drawTimer(gameState.elapsed);
  }
}
