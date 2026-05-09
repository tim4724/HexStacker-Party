'use strict';

// =====================================================================
// Display Test Harness — window.__TEST__ API and scenario builders
// Depends on: DisplayState.js (globals: urlParams, debugCount), DisplayUI.js, DisplayGame.js
// Loaded before display.js; only active when ?test=1, ?debug=N, or ?adclip=1
// =====================================================================

var _adclipMode = urlParams.get('adclip') === '1';

// Deterministic Math.random override when ?seed=<int> is present. The engine
// has its own seed plumbed via bootLocalGame; this catches non-engine
// randomness (animations, particles, micro-jitter) so captured frames are
// identical across runs.
if (urlParams.get('seed') !== null) {
  var _seedParam = parseInt(urlParams.get('seed'), 10);
  if (!isNaN(_seedParam)) {
    var _s = _seedParam >>> 0;
    Math.random = function() {
      _s |= 0; _s = (_s + 0x6D2B79F5) | 0;
      var t = _s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
}

if (urlParams.get('test') === '1' || debugCount > 0 || _adclipMode) {
  window.__TEST__ = {
    addPlayers: function(playerList) {
      for (var i = 0; i < playerList.length; i++) {
        var p = playerList[i];
        // Explicit slot lets gallery scenarios fake a non-contiguous roster
        // (e.g. 3 players + player 7 when "View as P7" is picked with
        // Players=4). Falls back to sequential fill for the usual case.
        var index = (typeof p.slot === 'number') ? p.slot : nextAvailableSlot();
        // joinedAt = array position → stable, incrementing within the seed so
        // calculateLayout()/electNextHost() get meaningful ordering. Using a
        // derived counter instead of Date.now() keeps scenarios deterministic.
        players.set(p.id, {
          playerName: sanitizePlayerName(p.name, index),
          playerIndex: index,
          startLevel: p.level || 1,
          joinedAt: i
        });
        playerOrder.push(p.id);
      }
      updatePlayerList();
      updateStartButton();
    },

    injectGameState: function(state) {
      setRoomState(ROOM_STATE.COUNTDOWN);
      setRoomState(ROOM_STATE.PLAYING);
      gameState = state;
      countdownOverlay.classList.add('hidden');
      showScreen(SCREEN.GAME);
      calculateLayout();
    },

    injectResults: function(results) {
      if (roomState === ROOM_STATE.LOBBY) {
        setRoomState(ROOM_STATE.COUNTDOWN);
        setRoomState(ROOM_STATE.PLAYING);
      }
      setRoomState(ROOM_STATE.RESULTS);
      lastResults = results;
      onGameEnd(results);
    },

    injectPause: function() {
      onGamePaused();
    },

    injectKO: function(playerId) {
      onPlayerKO({ playerId: playerId });
    },

    injectGarbageSent: function(data) {
      onGarbageSent(data);
    },

    injectCountdownGo: function() {
      onCountdownDisplay('GO');
    },

    setExtraGhosts: function(extraGhostsPerPlayer) {
      // Store for renderFrame to draw after each board render.
      // extraGhostsPerPlayer: array of arrays, one per player index.
      // Each inner array: [{ typeId, x, ghostY, blocks }]
      window.__TEST__._extraGhosts = extraGhostsPerPlayer;
    },

    // --- Ad-clip helpers ---
    // Boot a deterministic local game from a synthetic player roster, skipping
    // the relay/countdown so the composite orchestrator drives gameplay directly.
    bootLocalGame: function(opts) {
      opts = opts || {};
      var info = opts.playerInfo || [];
      var seed = (opts.seed != null) ? (opts.seed >>> 0) : 0;
      // Engine event handlers call party.broadcast / party.sendTo at multiple
      // sites — install a no-op stub so they don't throw in the no-network harness.
      window.party = window.party || { broadcast: function() {}, sendTo: function() {}, getMasterClientId: function() { return null; } };
      players.clear();
      playerOrder = [];
      for (var i = 0; i < info.length; i++) {
        var p = info[i];
        var slot = (typeof p.slot === 'number') ? p.slot : i;
        // Engine displays level = floor(lines / 10) + startLevel. To honour
        // a roster's `startLines` while keeping the displayed level pinned
        // to `p.level`, the harness back-computes startLevel and seeds the
        // board's `lines` counter below (after the game is constructed).
        var displayedLevel = p.level || 1;
        var startLines = p.startLines || 0;
        var internalStartLevel = Math.max(1, displayedLevel - Math.floor(startLines / 10));
        players.set(p.id, {
          playerName: sanitizePlayerName(p.name, slot),
          playerIndex: slot,
          startLevel: internalStartLevel,
          joinedAt: i
        });
        playerOrder.push(p.id);
      }
      setRoomState(ROOM_STATE.COUNTDOWN);
      setRoomState(ROOM_STATE.PLAYING);
      countdownOverlay.classList.add('hidden');
      countdownNumber.textContent = '';
      showScreen(SCREEN.GAME);
      calculateLayout();
      runGameLocallyWithSeed(seed);
      startRenderLoop();
      // Suppress the live elapsed timer overlay in adclip mode — patch the
      // snapshot so the renderer's `gameState.elapsed != null` gate fails.
      if (_adclipMode && displayGame) {
        var origGetSnapshot = displayGame.getSnapshot.bind(displayGame);
        displayGame.getSnapshot = function() {
          var s = origGetSnapshot();
          s.elapsed = null;
          return s;
        };
      }
      // Seed each board's LINES counter from the roster's `startLines`.
      // Combined with the back-computed startLevel above, this produces a
      // displayed level matching the roster spec (level=11 with lines=105
      // shows "LEVEL 11 / LINES 105" rather than "LEVEL 11 / LINES 0").
      if (displayGame) {
        for (var li = 0; li < info.length; li++) {
          var lp = info[li];
          if (!lp.startLines) continue;
          var lboard = displayGame.boards.get(lp.id);
          if (lboard) lboard.lines = lp.startLines;
        }
      }

      // Pre-populate the bottom of each board with a non-completing pattern
      // so the placed-block style (NORMAL / PILLOW / NEON_FLAT) reads
      // immediately. Each gameplay beat showcases its tier visually instead
      // of needing 30 seconds of AI play to build a stack.
      if (opts.prefillRows && displayGame) {
        var rows = Math.max(1, Math.min(opts.prefillRows, 8));
        var HC = GameConstants.COLS;
        var TR = GameConstants.TOTAL_ROWS;
        var BR = GameConstants.BUFFER_ROWS;
        var findCZ = GameConstants.findClearableZigzags;
        var nTypes = GameConstants.PIECE_TYPES.length;
        var seedFn = function(salt) {
          var s = (seed + salt) >>> 0;
          return function() {
            s |= 0; s = (s + 0x6D2B79F5) | 0;
            var t = s;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
          };
        };
        var bIdx = 0;
        for (var entry of displayGame.boards) {
          var pBoard = entry[1];
          var rng = seedFn(bIdx * 17 + 1);
          // Force 2 gaps per row at distinct columns. With 9/11 cells filled
          // a zigzag-down can never complete (needs all 11). For zigzag-up
          // we offset gap columns row-to-row so no alternating-pattern line
          // forms. The engine's findClearableZigzags is then re-checked and
          // any residual clear is broken by punching one more gap.
          var prevGaps = [-1, -1];
          for (var r = TR - rows; r < TR; r++) {
            var g1 = Math.floor(rng() * HC);
            var g2 = (g1 + 3 + Math.floor(rng() * (HC - 5))) % HC;
            // Avoid identical gap columns to the row above so zigzag-up
            // patterns don't accumulate.
            if (g1 === prevGaps[0] || g1 === prevGaps[1]) g1 = (g1 + 1) % HC;
            if (g2 === prevGaps[0] || g2 === prevGaps[1] || g2 === g1) g2 = (g2 + 2) % HC;
            for (var c = 0; c < HC; c++) {
              if (c === g1 || c === g2) continue;
              pBoard.grid[r][c] = Math.floor(rng() * nTypes) + 1;
            }
            prevGaps = [g1, g2];
          }
          // Belt-and-braces: scan for any remaining clearable zigzag and
          // empty one cell of it so the engine can't pop the prefill on
          // the AI's first piece lock.
          var grid = pBoard.grid;
          var safety = 0;
          while (safety++ < 6) {
            var result = findCZ(HC, TR, function(col, row) { return grid[row][col] !== 0; }, null, BR);
            if (result.linesCleared === 0) break;
            var cellsToBreak = result.clearCells.slice(0, result.linesCleared);
            for (var ci = 0; ci < cellsToBreak.length; ci++) {
              grid[cellsToBreak[ci][1]][cellsToBreak[ci][0]] = 0;
            }
          }
          pBoard.gridVersion++;
          bIdx++;
        }
      }
    },

    applyMove: function(playerIdx, action) {
      if (!displayGame) return false;
      var id = playerOrder[playerIdx];
      if (!id) return false;
      var board = displayGame.boards.get(id);
      if (!board || !board.alive) return false;
      switch (action) {
        case 'moveLeft': return board.moveLeft();
        case 'moveRight': return board.moveRight();
        case 'rotateCW': return board.rotateCW();
        case 'rotateCCW': return board.rotateCCW();
        case 'hold': return board.hold();
        case 'hardDrop': {
          var result = board.hardDrop();
          if (result && displayGame.callbacks && displayGame.callbacks.onEvent) {
            displayGame.callbacks.onEvent({
              type: 'piece_lock',
              playerId: id,
              blocks: result.lockedBlocks,
              typeId: result.lockedTypeId
            });
            if (result.linesCleared > 0) {
              displayGame.handleLineClear(id, result);
            }
          }
          return !!result;
        }
      }
      return false;
    },

    // Inject garbage rows directly onto a player's board (engine-side path,
    // not just the indicator). Picks the gap deterministically from playerIdx
    // so seeded captures stay frame-identical.
    injectGarbage: function(toPlayerIdx, lines) {
      if (!displayGame) return false;
      var id = playerOrder[toPlayerIdx];
      if (!id) return false;
      var board = displayGame.boards.get(id);
      if (!board || !board.alive) return false;
      var gap = (toPlayerIdx * 3 + 5) % GameConstants.COLS;
      board.applyGarbage(lines, gap);
      // Fire the indicator animation so the receiver visually shakes.
      var senderId = playerOrder[(toPlayerIdx + 1) % playerOrder.length] || id;
      onGarbageSent({ toId: id, senderId: senderId, lines: lines });
      return true;
    },

    // Stage a 4-row near-clear setup on a player's board and force-spawn an
    // I-piece so the AI's natural plan (vertical I → drop into the gap)
    // actually completes the rows. The clear, garbage send, and indicator
    // then flow through the engine's real handleLineClear path on lock —
    // pieces visibly cause the clear instead of cells appearing magically.
    //
    // gapCol fixes the empty column across the bottom 4 rows; rows TR-4..TR-1
    // become a vertical "well" exactly the size of a rotated I-piece. The
    // prefill's gap-pattern in those rows is overwritten; cells cycle types
    // so the renderer paints them in the player's tier style.
    primeForIClear: function(playerIdx, gapCol) {
      if (!displayGame) return false;
      var id = playerOrder[playerIdx];
      if (!id) return false;
      var board = displayGame.boards.get(id);
      if (!board || !board.alive) return false;

      var HC = GameConstants.COLS;
      var TR = GameConstants.TOTAL_ROWS;
      var nTypes = GameConstants.PIECE_TYPES.length;
      gapCol = ((gapCol % HC) + HC) % HC;

      // Clear gapCol all the way up so the falling I-piece has an
      // unobstructed path to the bottom of the well.
      for (var r = 0; r < TR - 4; r++) {
        board.grid[r][gapCol] = 0;
      }
      for (var r = TR - 4; r < TR; r++) {
        for (var c = 0; c < HC; c++) {
          board.grid[r][c] = (c === gapCol) ? 0 : (((c + r) % nTypes) + 1);
        }
      }
      board.gridVersion++;

      // Force the next piece to be I and respawn so the AI's first plan sees
      // a vertical I-piece in front of a 4-row column gap — the 4-line clear
      // then dominates planNextPlacement's heuristic (linesCleared * 100).
      board.nextPieces.unshift('I');
      board.currentPiece = null;
      board.spawnPiece();
      return true;
    }
  };

  // Hide irrelevant adclip-mode chrome — toolbar (mute/fullscreen/pause icons),
  // version label — both pull attention away from the game.
  if (_adclipMode) {
    var _hide = function() {
      var ids = ['game-toolbar', 'lobby-version-label', 'welcome-version-label', 'lobby-footer'];
      for (var i = 0; i < ids.length; i++) {
        var el = document.getElementById(ids[i]);
        if (el) el.style.display = 'none';
      }
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', _hide);
    } else {
      _hide();
    }
    // Synthesised "press" visual for the lobby clip's fake START click.
    // Mirrors .btn-primary:active's transform but adds a brightness flash
    // so the press reads in a 200ms window at 30fps capture.
    var pressStyle = document.createElement('style');
    pressStyle.textContent = [
      '#start-btn.adclip-pressed {',
      '  transform: translateY(2px) scale(0.97);',
      '  filter: brightness(1.25);',
      '  box-shadow: none;',
      '  transition: transform 80ms ease-out, filter 80ms ease-out;',
      '}'
    ].join('');
    if (document.head) document.head.appendChild(pressStyle);
  }

  // Signal readiness so the composite orchestrator can begin its timeline.
  // Posted on next tick so addPlayers / boot calls can land first.
  if (_adclipMode) {
    setTimeout(function() {
      try { window.parent.postMessage({ type: 'adclip-ready', role: 'display' }, '*'); } catch (_) {}
    }, 0);
  }
}

// =====================================================================
// Debug State Builder
// =====================================================================

function _buildHexDebugState(debugPlayers, level) {
  var HC = GameConstants.COLS;
  var HV = GameConstants.VISIBLE_ROWS;
  var GC = GameConstants.GARBAGE_CELL;
  var types = GameConstants.PIECE_TYPES;
  var emptyRow = function() { var r = []; for (var i = 0; i < HC; i++) r.push(0); return r; };
  var fullRow = function(gap) { var r = []; for (var i = 0; i < HC; i++) r.push(i === gap ? 0 : GC); return r; };
  var state = { players: [], elapsed: 75000 };
  for (var dj = 0; dj < debugPlayers.length; dj++) {
    var grid = []; for (var r = 0; r < HV; r++) grid.push(emptyRow());
    for (var br = HV - 3; br < HV; br++) {
      for (var bc = 0; bc < HC; bc++) {
        if ((bc + br + dj) % 4 !== 0) grid[br][bc] = ((bc + br) % types.length) + 1;
      }
    }
    grid[HV - 1] = fullRow((dj * 2 + 3) % HC);
    var pt = types[dj % types.length];
    var piece = new PieceModule.Piece(pt);
    piece.anchorCol = 5; piece.anchorRow = 2;
    var blocks = piece.getAbsoluteBlocks();
    var ghostPiece = piece.clone(); ghostPiece.anchorRow = HV - 5;
    state.players.push({
      id: debugPlayers[dj].id, playerName: debugPlayers[dj].name,
      grid: grid, lines: [24,16,10,5,20,12,8,3][dj % 8], level: level || [3,2,2,1,3,2,1,1][dj % 8],
      alive: true,
      currentPiece: { type: pt, typeId: piece.typeId, anchorCol: 5, anchorRow: 2, cells: piece.cells, blocks: blocks },
      ghost: { anchorCol: ghostPiece.anchorCol, anchorRow: ghostPiece.anchorRow, blocks: ghostPiece.getAbsoluteBlocks() },
      nextPieces: [types[(dj+1)%types.length], types[(dj+2)%types.length], types[(dj+3)%types.length]],
      holdPiece: types[(dj+4)%types.length],
      pendingGarbage: dj % 3 === 0 ? 3 : 0
    });
  }
  return state;
}

function _buildDebugPlayers(count, level, hostSlot) {
  var names = ['Emma', 'Jake', 'Sofia', 'Liam', 'Mia', 'Noah', 'Ava', 'Leo'];
  var max = Math.min(count, 8);
  // Build the slot list. Usually slots fill sequentially 0..count-1; but when
  // the scenario host (viewAs) lives outside that range, we swap the last
  // sequential slot for hostSlot so the gallery preview actually contains
  // the player you're "viewing as" (e.g. Players=4 + viewAs=P7 → slots
  // [0, 1, 2, 6], not [0, 1, 2, 3] with P7 as a ghost host).
  var slots = [];
  var needsHost = typeof hostSlot === 'number' && hostSlot >= 0 && hostSlot < 8 && hostSlot >= max;
  var fill = needsHost ? max - 1 : max;
  for (var s = 0; s < fill; s++) slots.push(s);
  if (needsHost) slots.push(hostSlot);
  var list = [];
  for (var i = 0; i < slots.length; i++) {
    var slot = slots[i];
    list.push({
      id: 'debug' + slot,
      name: names[slot] || ('P' + (slot + 1)),
      level: level,
      slot: slot
    });
  }
  return list;
}

// Run an animation trigger after the iframe has painted its first frame.
// BoardRenderers are created inside calculateLayout (via showScreen(GAME)),
// so we need a tick before addHexCellClear/onGarbageSent can find them.
function _delayTrigger(fn, ms) {
  setTimeout(fn, ms || 500);
}

function _fireLineClear(playerIdx, lines) {
  if (!animations || !boardRenderers[playerIdx]) return;
  var HC = GameConstants.COLS;
  var HV = GameConstants.VISIBLE_ROWS;
  // addHexCellClear expects [col, row] tuples, not {col,row} objects.
  var cells = [];
  var rowCount = Math.max(1, Math.min(lines || 1, 4));
  for (var r = 0; r < rowCount; r++) {
    for (var c = 0; c < HC; c++) cells.push([c, HV - 1 - r]);
  }
  animations.addHexCellClear(boardRenderers[playerIdx], cells, rowCount);
}

function _fakeLobbyQR() {
  // Adclip mode shows the bare site (no room code) so the QR + URL function
  // as a clean CTA. Gallery preview keeps the historic hexstacker.com/TEST
  // styling so the join-url two-part rendering still gets verified.
  var qrTarget = _adclipMode ? 'https://hexstacker.com' : 'https://hexstacker.com/TEST12';
  if (joinUrlEl) {
    var hostEl = joinUrlEl.querySelector('.join-url__host');
    var codeEl = joinUrlEl.querySelector('.join-url__code');
    if (_adclipMode) {
      // Single-line "hexstacker.com" — drop the slash + room code that the
      // gallery preview uses. Match by clearing the code span and dropping
      // the trailing slash on host.
      if (hostEl && codeEl) {
        hostEl.textContent = 'hexstacker.com';
        codeEl.textContent = '';
      } else if (joinUrlEl) {
        joinUrlEl.textContent = 'hexstacker.com';
      }
    } else if (hostEl && codeEl) {
      hostEl.textContent = 'hexstacker.com/';
      codeEl.textContent = 'TEST';
    } else {
      joinUrlEl.textContent = 'hexstacker.com/TEST';
    }
  }
  fetch('/api/qr?text=' + encodeURIComponent(qrTarget))
    .then(function(r) { return r.json(); })
    .then(function(matrix) { if (qrCode) renderQR(qrCode, matrix); })
    .catch(function() { /* gallery works without QR — ignore */ });
}

// =====================================================================
// Scenario Init — called from display.js when ?debug=N or ?scenario=...
// =====================================================================

function initScenario(opts) {
  opts = opts || {};
  var scenario = opts.scenario || 'playing';
  // Allow players=0 explicitly (adclip lobby starts empty). Other scenarios
  // pass count directly so 0 stays meaningful through the clamp.
  var rawCount = (opts.players != null) ? opts.players : 1;
  var playerCount = Math.max(0, Math.min(rawCount, 8));
  var level = opts.level || 1;

  // Host override for gallery previews. getHostClientId() consults
  // party.getMasterClientId() first, so stubbing it lets us render the
  // same scenario with different players designated as host (Start button
  // tint follows the host's player color).
  var hostSlot = null;
  if (opts.host !== null && opts.host !== undefined && !isNaN(opts.host)) {
    hostSlot = Math.max(0, Math.min(opts.host, 7));
    party = { getMasterClientId: function() { return 'debug' + hostSlot; } };
  }

  // Welcome: no players, stay on welcome screen.
  if (scenario === 'welcome') {
    showScreen(SCREEN.WELCOME);
    return;
  }

  // Lobby: populate players and show lobby screen.
  if (scenario === 'lobby') {
    window.__TEST__.addPlayers(_buildDebugPlayers(playerCount, level, hostSlot));
    _fakeLobbyQR();
    showScreen(SCREEN.LOBBY);
    return;
  }

  // AirConsole lobby variant — adds `body.airconsole` so the CSS overrides
  // in display.css hide QR/join URL and collapse the player list into the
  // compact AirConsole layout.
  if (scenario === 'airconsole-lobby') {
    document.body.classList.add('airconsole');
    window.__TEST__.addPlayers(_buildDebugPlayers(playerCount, level, hostSlot));
    showScreen(SCREEN.LOBBY);
    return;
  }

  // Bail-toast variants. Display gallery iframes are wider than the
  // mobile-only media-query that normally reveals the overlay, so force
  // it visible by removing `.hidden` (the base `.device-choice` rule
  // already sets display: flex). showBailToast handles the 5s auto-hide.
  var bailScenarios = {
    'bail-room-not-found': 'room_not_found',
    'bail-game-full': 'game_full',
    'bail-game-ended': 'game_ended'
  };
  if (bailScenarios[scenario]) {
    var key = bailScenarios[scenario];
    var deviceChoiceEl = document.getElementById('device-choice');
    if (deviceChoiceEl) deviceChoiceEl.classList.remove('hidden');
    showScreen(SCREEN.WELCOME);
    showBailToast(key);
    window.__TEST__.replay = function() { showBailToast(key); };
    return;
  }

  // All other scenarios need players + some game state.
  var debugPlayers = _buildDebugPlayers(playerCount, level, hostSlot);
  window.__TEST__.addPlayers(debugPlayers);

  if (scenario === 'countdown') {
    setRoomState(ROOM_STATE.COUNTDOWN);
    showScreen(SCREEN.GAME);
    calculateLayout();
    startRenderLoop();
    // Play 3 → 2 → 1 → GO once on a 1s tick (audio is a no-op without music
    // init, which only happens on user interaction). The gallery's ▶ replay
    // button re-runs this on demand; initial load freezes at "3" so the
    // preview has something visible without auto-playing.
    var sequence = ['3', '2', '1', 'GO'];
    var pendingTimers = [];
    function clearPending() {
      for (var pi = 0; pi < pendingTimers.length; pi++) clearTimeout(pendingTimers[pi]);
      pendingTimers = [];
    }
    function resetToInitial() {
      countdownOverlay.classList.remove('hidden');
      countdownNumber.textContent = '3';
    }
    function startCountdown() {
      clearPending();
      // Tear down any live countdown timers from a previous run so a rapid
      // replay can't race its predecessor (GO-hide, music-start, or the
      // tick interval firing against the new sequence). Mirror the full
      // DisplayGame.stopCountdown teardown.
      if (countdown.timer) { clearInterval(countdown.timer); countdown.timer = null; }
      if (countdown.goTimeout) { clearTimeout(countdown.goTimeout); countdown.goTimeout = null; }
      if (countdown.overlayTimer) { clearTimeout(countdown.overlayTimer); countdown.overlayTimer = null; }
      countdownOverlay.classList.add('hidden');
      countdownNumber.textContent = '';
      // Boot the audio context so playCountdownBeep actually beeps. Only
      // invoked from the gallery's ▶ button, so we have a user gesture
      // even though the harness itself runs on load.
      initMusic();
      var idx = 0;
      (function tick() {
        onCountdownDisplay(sequence[idx]);
        idx++;
        if (idx < sequence.length) {
          pendingTimers.push(setTimeout(tick, 1000));
        } else {
          // Post-GO: onCountdownDisplay('GO') hides the overlay and starts
          // game music. Silence the music once the overlay is gone, then
          // reset the card to its initial paused "3" state at 2s.
          pendingTimers.push(setTimeout(function() {
            if (music && music.playing) music.stop();
          }, 500));
          pendingTimers.push(setTimeout(resetToInitial, 2000));
        }
      })();
    }
    resetToInitial();
    window.__TEST__.replay = startCountdown;
    return;
  }

  var state = _buildHexDebugState(debugPlayers, level);
  window.__TEST__.injectGameState(state);
  startRenderLoop();

  if (scenario === 'pause') {
    window.__TEST__.injectPause();
    return;
  }
  if (scenario === 'ko') {
    // KO every player — grand-finale visual.
    for (var kI = 0; kI < debugPlayers.length; kI++) {
      window.__TEST__.injectKO(debugPlayers[kI].id);
      state.players[kI].alive = false;
    }
    return;
  }
  if (scenario === 'line-clear') {
    var HC_lc = GameConstants.COLS;
    var HV_lc = GameConstants.VISIBLE_ROWS;
    var types_lc = GameConstants.PIECE_TYPES;
    // Wipe slot 0 clean so only the rows about to be cleared are filled —
    // otherwise the debug state's checkerboard on row HV-3 stays visible
    // after the clear and it looks like the clear didn't work.
    for (var rClean = 0; rClean < HV_lc; rClean++) {
      for (var cClean = 0; cClean < HC_lc; cClean++) {
        state.players[0].grid[rClean][cClean] = 0;
      }
    }
    for (var lr = HV_lc - 2; lr < HV_lc; lr++) {
      for (var lc = 0; lc < HC_lc; lc++) {
        state.players[0].grid[lr][lc] = ((lc + lr) % types_lc.length) + 1;
      }
    }
    state.players[0].gridVersion = 0;
    _delayTrigger(function() {
      _fireLineClear(0, 2);
      // Zero cells + bump gridVersion after the engine's own clear delay,
      // so BoardRenderer cache invalidates and rows visibly vanish just like
      // in a real game. Tied to engine timing via GameConstants so it tracks
      // any future tweak.
      setTimeout(function() {
        for (var r2 = HV_lc - 2; r2 < HV_lc; r2++) {
          for (var c2 = 0; c2 < HC_lc; c2++) state.players[0].grid[r2][c2] = 0;
        }
        state.players[0].gridVersion++;
      }, GameConstants.LINE_CLEAR_DELAY_MS);
    });
    return;
  }
  if (scenario === 'garbage-add') {
    // Reset baseline pending so the incoming animation starts clean — the
    // debug state seeds slot 0 with 3 pending, which would mask the effect.
    for (var gi = 0; gi < state.players.length; gi++) state.players[gi].pendingGarbage = 0;
    _delayTrigger(function() {
      onGarbageSent({
        toId: debugPlayers[0].id,
        senderId: debugPlayers[Math.min(1, debugPlayers.length - 1)].id,
        lines: 3
      });
      // Leave the meter filled in — the indicator animation is temporary but
      // the pending count should persist so the "incoming garbage" state is
      // visible after the effect fades.
      state.players[0].pendingGarbage = 3;
    });
    return;
  }
  if (scenario === 'garbage-defend') {
    // Seed pendingGarbage so onGarbageCancelled has something to cancel.
    state.players[0].pendingGarbage = 3;
    _delayTrigger(function() {
      onGarbageCancelled({ playerId: debugPlayers[0].id, lines: 2 });
      // Drop pending to reflect the cancellation in the next frame.
      state.players[0].pendingGarbage = 1;
    });
    return;
  }
  if (scenario === 'effects-combo') {
    // Gallery combo: boards 0–3 each demonstrate one effect at once so a
    // single preview tile covers line-clear / garbage-in / defend / KO.
    // Gated to players>=4 by the gallery, but guard anyway.
    if (state.players.length < 4) return;

    var HC_c = GameConstants.COLS;
    var HV_c = GameConstants.VISIBLE_ROWS;
    var types_c = GameConstants.PIECE_TYPES;

    // "Before" state — boards are in the pre-animation configuration the
    // replay will transition out of: board 0 has a filled stack to clear,
    // board 1 has zero pending (incoming garbage will raise it), board 2
    // has 3 pending (defend will cancel most of it), board 3 is alive
    // (KO will take it down). gridVersion starts at 0 so the runEffects
    // tick's `++` produces a clean 0→1 change for BoardRenderer to pick up.
    function seedBoards() {
      for (var rClean = 0; rClean < HV_c; rClean++) {
        for (var cClean = 0; cClean < HC_c; cClean++) {
          state.players[0].grid[rClean][cClean] = 0;
        }
      }
      for (var lr = HV_c - 2; lr < HV_c; lr++) {
        for (var lc = 0; lc < HC_c; lc++) {
          state.players[0].grid[lr][lc] = ((lc + lr) % types_c.length) + 1;
        }
      }
      state.players[0].gridVersion = 0;
      state.players[1].pendingGarbage = 0;
      state.players[2].pendingGarbage = 3;
      state.players[3].alive = true;
    }

    function runEffects() {
      seedBoards();
      _delayTrigger(function() {
        _fireLineClear(0, 2);
        setTimeout(function() {
          for (var r2 = HV_c - 2; r2 < HV_c; r2++) {
            for (var c2 = 0; c2 < HC_c; c2++) state.players[0].grid[r2][c2] = 0;
          }
          state.players[0].gridVersion++;
        }, GameConstants.LINE_CLEAR_DELAY_MS);

        onGarbageSent({
          toId: debugPlayers[1].id,
          senderId: debugPlayers[2].id,
          lines: 3
        });
        state.players[1].pendingGarbage = 3;

        onGarbageCancelled({ playerId: debugPlayers[2].id, lines: 2 });
        state.players[2].pendingGarbage = 1;

        window.__TEST__.injectKO(debugPlayers[3].id);
        state.players[3].alive = false;
      });
    }
    seedBoards();
    window.__TEST__.replay = runEffects;
    return;
  }
  if (scenario === 'reconnecting') {
    reconnectOverlay.classList.remove('hidden');
    reconnectHeading.textContent = t('reconnecting');
    reconnectStatus.textContent = t('attempt_n_of_m', { attempt: 2, max: 5 });
    reconnectBtn.classList.add('hidden');
    return;
  }
  if (scenario === 'disconnected') {
    reconnectOverlay.classList.remove('hidden');
    reconnectHeading.textContent = t('disconnected');
    reconnectStatus.textContent = '';
    reconnectBtn.classList.remove('hidden');
    return;
  }
  if (scenario === 'results') {
    var results = { elapsed: 123456, results: [] };
    for (var i = 0; i < debugPlayers.length; i++) {
      var pInfo = players.get(debugPlayers[i].id);
      results.results.push({
        playerId: debugPlayers[i].id,
        playerName: debugPlayers[i].name,
        colorIndex: pInfo && pInfo.playerIndex,
        rank: i + 1,
        lines: 30 - i * 3,
        level: level + (playerCount - 1 - i)
      });
    }
    window.__TEST__.injectResults(results);
    return;
  }
  // 'playing' is the default — already handled by injectGameState above.
}

// Backwards-compat shim for any old callers.
function initDebugMode(count) {
  initScenario({ scenario: 'playing', players: count });
}
