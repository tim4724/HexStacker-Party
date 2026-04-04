'use strict';

// =====================================================================
// Display Test Harness — window.__TEST__ API and debug state builders
// Depends on: DisplayState.js (globals), DisplayUI.js, DisplayGame.js
// Loaded before display.js; only active when ?test=1 or ?debug=N
// =====================================================================

var urlParams = new URLSearchParams(window.location.search);
var debugCount = parseInt(urlParams.get('debug'), 10);
if (urlParams.get('test') === '1' || debugCount > 0) {
  window.__TEST__ = {
    addPlayers: function(playerList) {
      for (var i = 0; i < playerList.length; i++) {
        var p = playerList[i];
        var index = nextAvailableSlot();
        var color = PLAYER_COLORS[index % PLAYER_COLORS.length];
        players.set(p.id, {
          playerName: sanitizePlayerName(p.name, index),
          playerColor: color,
          playerIndex: index
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

    setGameMode: function(mode) {
      gameMode = mode;
      updateModeUI(mode);
    },

    setExtraGhosts: function(extraGhostsPerPlayer) {
      // Store for renderFrame to draw after each board render.
      // extraGhostsPerPlayer: array of arrays, one per player index.
      // Each inner array: [{ typeId, x, ghostY, blocks }]
      window.__TEST__._extraGhosts = extraGhostsPerPlayer;
    }
  };
}

// =====================================================================
// Debug State Builders
// =====================================================================

function _buildClassicDebugState(debugPlayers) {
  var VH = GameConstants.VISIBLE_HEIGHT;
  var debugGrids = [
    function() { var g = []; for (var r = 0; r < VH; r++) g.push([0,0,0,0,0,0,0,0,0,0]);
      g[VH-6]=[0,0,0,0,0,1,0,0,0,0]; g[VH-5]=[0,7,7,0,0,1,0,0,0,0];
      g[VH-4]=[2,0,7,7,0,1,0,0,0,3]; g[VH-3]=[2,2,2,0,0,1,0,3,3,3];
      g[VH-2]=[8,8,8,8,0,8,8,8,8,8]; g[VH-1]=[8,8,8,8,8,0,8,8,8,8]; return g; },
    function() { var g = []; for (var r = 0; r < VH; r++) g.push([0,0,0,0,0,0,0,0,0,0]);
      g[VH-4]=[0,5,5,0,4,4,6,6,6,0]; g[VH-3]=[5,5,0,0,4,4,0,6,0,0];
      g[VH-2]=[8,8,8,0,8,8,8,8,8,8]; g[VH-1]=[8,8,0,8,8,8,8,8,8,8]; return g; },
    function() { var g = []; for (var r = 0; r < VH; r++) g.push([0,0,0,0,0,0,0,0,0,0]);
      g[VH-5]=[0,0,0,0,0,0,0,0,7,0]; g[VH-4]=[0,0,0,0,0,0,0,7,7,0];
      g[VH-3]=[1,1,1,1,0,0,0,7,0,0]; g[VH-2]=[8,8,8,8,8,0,8,8,8,8]; g[VH-1]=[8,8,8,0,8,8,8,8,8,8]; return g; },
    function() { var g = []; for (var r = 0; r < VH; r++) g.push([0,0,0,0,0,0,0,0,0,0]);
      g[VH-5]=[0,5,0,0,0,0,3,3,0,0]; g[VH-4]=[0,5,5,0,0,0,0,3,0,0]; g[VH-3]=[0,0,5,0,0,0,0,3,0,0];
      g[VH-2]=[8,8,8,0,8,8,8,8,8,8]; g[VH-1]=[8,0,8,8,8,8,8,8,8,8]; return g; },
    function() { var g = []; for (var r = 0; r < VH; r++) g.push([0,0,0,0,0,0,0,0,0,0]);
      g[VH-4]=[0,0,0,0,0,6,6,6,2,0]; g[VH-3]=[5,5,3,3,0,0,6,0,2,2];
      g[VH-2]=[8,8,8,8,0,8,8,8,8,8]; g[VH-1]=[8,8,0,8,8,8,8,8,8,8]; return g; },
    function() { var g = []; for (var r = 0; r < VH; r++) g.push([0,0,0,0,0,0,0,0,0,0]);
      g[VH-4]=[4,4,0,0,0,0,0,5,5,0]; g[VH-3]=[4,4,0,0,0,0,5,5,0,0];
      g[VH-2]=[8,8,8,8,8,0,8,8,8,8]; g[VH-1]=[8,0,8,8,8,8,8,8,8,8]; return g; },
    function() { var g = []; for (var r = 0; r < VH; r++) g.push([0,0,0,0,0,0,0,0,0,0]);
      g[VH-4]=[0,0,0,0,0,0,0,3,0,0]; g[VH-3]=[1,1,1,1,0,3,3,3,0,0];
      g[VH-2]=[8,8,8,0,8,8,8,8,8,8]; g[VH-1]=[8,8,8,8,0,8,8,8,8,8]; return g; },
    function() { var g = []; for (var r = 0; r < VH; r++) g.push([0,0,0,0,0,0,0,0,0,0]);
      g[VH-3]=[0,0,7,7,0,0,0,0,0,0]; g[VH-2]=[8,8,0,7,7,8,8,8,0,8]; g[VH-1]=[8,8,8,8,0,8,8,8,8,8]; return g; }
  ];
  var debugPieces = [
    { typeId: 6, x: 7, y: 2, blocks: [[1,0],[0,1],[1,1],[2,1]] },
    { typeId: 2, x: 6, y: 3, blocks: [[0,0],[0,1],[1,1],[2,1]] },
    { typeId: 3, x: 3, y: 2, blocks: [[2,0],[0,1],[1,1],[2,1]] },
    { typeId: 6, x: 3, y: 3, blocks: [[1,0],[0,1],[1,1],[2,1]] },
    { typeId: 1, x: 0, y: 5, blocks: [[0,1],[1,1],[2,1],[3,1]] },
    { typeId: 5, x: 4, y: 3, blocks: [[1,0],[2,0],[0,1],[1,1]] },
    { typeId: 7, x: 1, y: 2, blocks: [[0,0],[1,0],[1,1],[2,1]] },
    { typeId: 4, x: 7, y: 3, blocks: [[0,0],[1,0],[0,1],[1,1]] }
  ];
  var debugGhostY = [14, 14, 15, 16, 15, 16, 15, 16];
  var debugHold = ['O', 'S', 'T', 'I', 'J', 'Z', 'L', 'S'];
  var debugNext = [
    ['I','T','Z','L','O'], ['T','J','O','S','Z'], ['Z','I','J','S','L'], ['L','O','T','I','S'],
    ['S','Z','T','J','I'], ['J','L','I','O','T'], ['O','S','L','Z','J'], ['T','I','Z','L','O']
  ];
  var debugLines = [24, 16, 10, 5, 20, 12, 8, 3];
  var debugLevels = [3, 2, 2, 1, 3, 2, 1, 1];
  var state = { players: [], elapsed: 75000 };
  for (var dj = 0; dj < debugPlayers.length; dj++) {
    state.players.push({
      id: debugPlayers[dj].id, playerName: debugPlayers[dj].name,
      grid: debugGrids[dj % debugGrids.length](),
      lines: debugLines[dj % debugLines.length], level: debugLevels[dj % debugLevels.length],
      alive: true, currentPiece: debugPieces[dj % debugPieces.length],
      ghostY: debugGhostY[dj % debugGhostY.length],
      nextPieces: debugNext[dj % debugNext.length], holdPiece: debugHold[dj % debugHold.length],
      pendingGarbage: dj % 3 === 0 ? 3 : 0
    });
  }
  return state;
}

function _buildHexDebugState(debugPlayers) {
  var HC = HexConstants.HEX_COLS;
  var HV = HexConstants.HEX_VISIBLE_ROWS;
  var GC = HexConstants.HEX_GARBAGE_CELL;
  var types = HexConstants.HEX_PIECE_TYPES;
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
    var piece = new HexPieceModule.HexPiece(pt);
    piece.anchorCol = 5; piece.anchorRow = 2;
    var blocks = piece.getAbsoluteBlocks();
    var ghostPiece = piece.clone(); ghostPiece.anchorRow = HV - 5;
    state.players.push({
      id: debugPlayers[dj].id, playerName: debugPlayers[dj].name,
      grid: grid, lines: [24,16,10,5,20,12,8,3][dj % 8], level: [3,2,2,1,3,2,1,1][dj % 8],
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

// =====================================================================
// Debug Mode Init — called from display.js when ?debug=N
// =====================================================================

function initDebugMode(debugCount) {
  var debugNames = ['Emma', 'Jake', 'Sofia', 'Liam', 'Mia', 'Noah', 'Ava', 'Leo'];
  var debugPlayers = [];
  for (var di = 0; di < Math.min(debugCount, 8); di++) {
    debugPlayers.push({ id: 'debug' + di, name: debugNames[di] || ('P' + (di + 1)) });
  }
  window.__TEST__.addPlayers(debugPlayers);

  var debugState;
  if (gameMode === 'hex') {
    debugState = _buildHexDebugState(debugPlayers);
  } else {
    debugState = _buildClassicDebugState(debugPlayers);
  }
  window.__TEST__.injectGameState(debugState);
  startRenderLoop();
}
