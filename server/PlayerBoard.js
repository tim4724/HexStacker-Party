'use strict';

// UMD: works in Node.js (require) and browser (window.GamePlayerBoard)
(function(exports) {

var constants = (typeof require !== 'undefined') ? require('./constants') : window.GameConstants;
var BaseBoardModule = (typeof require !== 'undefined') ? require('./BaseBoard') : window.BaseBoardModule;

var BOARD_WIDTH = constants.BOARD_WIDTH;
var BOARD_HEIGHT = constants.BOARD_HEIGHT;
var BUFFER_ROWS = constants.BUFFER_ROWS;
var GARBAGE_CELL = constants.GARBAGE_CELL;

var BaseBoard = BaseBoardModule.BaseBoard;
var LINE_CLEAR_DELAY_MS = BaseBoardModule.LINE_CLEAR_DELAY_MS;

var Piece = ((typeof require !== 'undefined') ? require('./Piece') : window.GamePiece).Piece;

class PlayerBoard extends BaseBoard {
  constructor(playerId, seed, startLevel) {
    super(playerId, seed, startLevel, {
      cols: BOARD_WIDTH,
      totalRows: BOARD_HEIGHT,
      bufferRows: BUFFER_ROWS
    });

    // Line clear animation state
    this.clearingRows = null;

    // Fill the next queue
    this._fillNextQueue();
  }

  // --- Abstract method implementations ---

  _createPiece(type) {
    return new Piece(type);
  }

  _isClearing() {
    return this.clearingRows !== null;
  }

  _drop(piece) {
    var test = piece.clone();
    test.y += 1;
    if (this.isValidPosition(test)) {
      return test;
    }
    return null;
  }

  _isOnSurface() {
    if (!this.currentPiece) return false;
    var test = this.currentPiece.clone();
    test.y += 1;
    return !this.isValidPosition(test);
  }

  _preDropToVisible() {
    if (!this.currentPiece) return;
    var targetY = BUFFER_ROWS - 1;
    while (this.currentPiece.y < targetY) {
      var test = this.currentPiece.clone();
      test.y += 1;
      if (this.isValidPosition(test)) {
        this.currentPiece.y = test.y;
      } else {
        break;
      }
    }
    this.gravityCounter = 0;
  }

  // --- Classic-specific methods ---

  moveLeft() {
    if (!this.currentPiece || !this.alive) return false;
    const test = this.currentPiece.clone();
    test.x -= 1;
    if (this.isValidPosition(test)) {
      this.currentPiece.x = test.x;
      this._resetLockTimerIfOnSurface();
      return true;
    }
    return false;
  }

  moveRight() {
    if (!this.currentPiece || !this.alive) return false;
    const test = this.currentPiece.clone();
    test.x += 1;
    if (this.isValidPosition(test)) {
      this.currentPiece.x = test.x;
      this._resetLockTimerIfOnSurface();
      return true;
    }
    return false;
  }

  rotateCW() {
    if (!this.currentPiece || !this.alive) return false;
    if (this.currentPiece.type === 'O') return false;

    const toRotation = (this.currentPiece.rotation + 1) % 4;
    const kicks = this.currentPiece.getWallKicks();

    for (const [dx, dy] of kicks) {
      const test = this.currentPiece.clone();
      test.rotation = toRotation;
      test.x += dx;
      test.y -= dy; // kick offsets use y-up, our grid is y-down
      if (this.isValidPosition(test)) {
        this.currentPiece.rotation = toRotation;
        this.currentPiece.x = test.x;
        this.currentPiece.y = test.y;
        this._resetLockTimerIfOnSurface();
        return true;
      }
    }
    return false;
  }

  hardDrop() {
    if (!this.currentPiece || !this.alive) return null;
    while (true) {
      const test = this.currentPiece.clone();
      test.y += 1;
      if (this.isValidPosition(test)) {
        this.currentPiece.y = test.y;
      } else {
        break;
      }
    }
    return this._lockAndProcess();
  }

  _lockAndProcess() {
    // Capture locked block positions before lockPiece() clears currentPiece
    var lockedBlocks = [];
    var lockedTypeId = 0;
    if (this.currentPiece) {
      lockedTypeId = this.currentPiece.typeId;
      var abs = this.currentPiece.getAbsoluteBlocks();
      for (var i = 0; i < abs.length; i++) {
        var visibleRow = abs[i][1] - BUFFER_ROWS;
        if (visibleRow >= 0) {
          lockedBlocks.push([abs[i][0], visibleRow]);
        }
      }
    }

    this.lockPiece();

    // Detect full rows
    const fullRows = [];
    for (let row = 0; row < BOARD_HEIGHT; row++) {
      if (this.grid[row].every(cell => cell !== 0)) {
        fullRows.push(row);
      }
    }

    const linesCleared = fullRows.length;

    if (linesCleared > 0) {
      this.lines += linesCleared;

      // Start clearing animation - delay actual row removal
      this.clearingRows = fullRows;
      this.clearingTimer = LINE_CLEAR_DELAY_MS;
      this.currentPiece = null;
    } else {
      this._applyPendingGarbage();
      this.spawnPiece();
    }

    return {
      linesCleared,
      fullRows: fullRows.map(r => r - BUFFER_ROWS),
      alive: this.alive,
      lockedBlocks,
      lockedTypeId
    };
  }

  _finishClearLines() {
    if (!this.clearingRows) return;

    // Remove the clearing rows from the grid
    for (let i = this.clearingRows.length - 1; i >= 0; i--) {
      this.grid.splice(this.clearingRows[i], 1);
    }
    // Add empty rows at top to maintain board height
    for (let i = 0; i < this.clearingRows.length; i++) {
      this.grid.unshift(new Array(BOARD_WIDTH).fill(0));
    }

    this.clearingRows = null;
    this.clearingTimer = null;

    this._applyPendingGarbage();
    this.spawnPiece();
  }

  lockPiece() {
    if (!this.currentPiece) return;
    const blocks = this.currentPiece.getAbsoluteBlocks();
    for (const [col, row] of blocks) {
      if (row >= 0 && row < BOARD_HEIGHT && col >= 0 && col < BOARD_WIDTH) {
        this.grid[row][col] = this.currentPiece.typeId;
      }
    }
  }

  applyGarbage(lines, gapColumn) {
    // Remove rows from top to make room
    this.grid.splice(0, lines);
    // Add garbage rows at bottom
    for (let i = 0; i < lines; i++) {
      const row = new Array(BOARD_WIDTH).fill(GARBAGE_CELL);
      row[gapColumn] = 0;
      this.grid.push(row);
    }
  }

  isValidPosition(piece) {
    const blocks = piece.getAbsoluteBlocks();
    for (const [col, row] of blocks) {
      if (col < 0 || col >= BOARD_WIDTH) return false;
      if (row < 0 || row >= BOARD_HEIGHT) return false;
      if (this.grid[row][col] !== 0) return false;
    }
    return true;
  }

  getGhostY() {
    if (!this.currentPiece) return 0;
    const test = this.currentPiece.clone();
    while (true) {
      test.y += 1;
      if (!this.isValidPosition(test)) {
        return test.y - 1;
      }
    }
  }

  getState() {
    // Return only visible rows (bottom 22 of the 26-row grid)
    const visibleGrid = this.grid.slice(BUFFER_ROWS);

    return {
      grid: visibleGrid,
      currentPiece: this.currentPiece ? {
        type: this.currentPiece.type,
        typeId: this.currentPiece.typeId,
        rotation: this.currentPiece.rotation,
        x: this.currentPiece.x,
        y: this.currentPiece.y - BUFFER_ROWS,
        blocks: this.currentPiece.getBlocks()
      } : null,
      ghostY: this.currentPiece ? this.getGhostY() - BUFFER_ROWS : null,
      holdPiece: this.holdPiece,
      nextPieces: this.nextPieces.slice(0, 3),
      level: this.getLevel(),
      lines: this.lines,
      alive: this.alive,
      pendingGarbage: this.pendingGarbage.reduce((sum, g) => sum + g.lines, 0),
      clearingRows: this.clearingRows ? this.clearingRows.map(r => r - BUFFER_ROWS) : null
    };
  }
}

exports.PlayerBoard = PlayerBoard;

})(typeof module !== 'undefined' ? module.exports : (window.GamePlayerBoard = {}));
