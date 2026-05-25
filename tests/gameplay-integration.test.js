'use strict';

// Integration tests at the lock→spawn boundary. Unit tests catch single-piece
// behaviour; these catch state that leaks between pieces (scratch arrays,
// caches, queue versions) — the class of bug introduced when the piece set
// went mixed-size.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { PlayerBoard } = require('../server/PlayerBoard');
const { Piece } = require('../server/Piece');
const {
  PIECE_TYPES,
  LINE_CLEAR_DELAY_MS,
  COLS: HEX_COLS,
  TOTAL_ROWS: HEX_TOTAL_ROWS,
} = require('../server/constants');

function countCells(grid) {
  var n = 0;
  for (var r = 0; r < grid.length; r++) {
    var row = grid[r];
    for (var c = 0; c < row.length; c++) if (row[c] > 0) n++;
  }
  return n;
}

// Force the next spawn to be a specific piece type: push at the front of the
// next queue, null the current piece, respawn.
function forceNextPiece(board, type) {
  board.nextPieces.unshift(type);
  board.currentPiece = null;
  board.spawnPiece();
}

describe('Gameplay - state invariants across piece transitions', () => {
  it('every piece type can lock and the next spawn survives', () => {
    // Per-type smoke test: lock one of each, confirm the engine doesn't KO
    // on the next spawn (catches "first piece kills the board" bugs).
    for (var t = 0; t < PIECE_TYPES.length; t++) {
      var type = PIECE_TYPES[t];
      var b = new PlayerBoard('p1', 42, 1);
      b.spawnPiece();
      forceNextPiece(b, type);
      assert.equal(b.currentPiece.type, type, 'forced type took effect');
      var pieceCells = b.currentPiece.cells.length;
      var result = b.hardDrop();
      assert.equal(result.alive, true,
        type + ' lock should not kill the board');
      assert.ok(b.currentPiece || b.clearingCells,
        type + ': next piece spawned or clearing started');
      // No phantom cells.
      if (result.linesCleared === 0) {
        assert.equal(countCells(b.grid), pieceCells,
          type + ': grid contains exactly the locked piece\'s cells');
      }
    }
  });

  it('mixed-size lock sequence does not leak between scratch entries', () => {
    // Targeted regression: the original bug was a 4-cell scratch leaving a
    // stale entry visible to a subsequent 3-cell piece. Drive a 4→3→4→3 sequence
    // and assert the cell count is exact after every lock.
    var b = new PlayerBoard('p1', 42, 1);
    b.spawnPiece();
    var expected = 0;
    var sequence = ['o', 'V3', 'd', 'T3', 'b', 'I3'];
    for (var i = 0; i < sequence.length; i++) {
      forceNextPiece(b, sequence[i]);
      var pieceCells = b.currentPiece.cells.length;
      var result = b.hardDrop();
      assert.equal(result.alive, true,
        sequence[i] + ' (lock ' + i + ') should not kill the board');
      if (result.linesCleared > 0) {
        b.tick(LINE_CLEAR_DELAY_MS + 1);
        expected = countCells(b.grid);
      } else {
        expected += pieceCells;
        assert.equal(countCells(b.grid), expected,
          'cell count after ' + sequence[i] + ': expected ' + expected);
      }
    }
  });

  it('cell-count invariant holds across 20 hard-drops', () => {
    // General invariant: after each lock without clear, total cells equals
    // sum of locked piece sizes; after a clear, the grid count matches whatever
    // findClearableZigzags removed. Catches phantom cells, double-locks,
    // and silent grid-mutation bugs.
    //
    // Pieces are deliberately spread across columns — at center-only stacking,
    // the board overfills before iteration 30 and we lose coverage of the
    // bug class this test exists to catch.
    var b = new PlayerBoard('p1', 42, 1);
    b.spawnPiece();
    var lockedSinceClear = 0;
    var locks = 0;
    for (var i = 0; i < 20; i++) {
      assert.equal(b.alive, true,
        'board should still be alive at iteration ' + i);
      // Spread pieces across columns to avoid pile-up at center.
      var targetCol = i % HEX_COLS;
      while (b.currentPiece.anchorCol > targetCol && b.moveLeft()) {}
      while (b.currentPiece.anchorCol < targetCol && b.moveRight()) {}
      var pieceCells = b.currentPiece.cells.length;
      var prevGV = b.gridVersion;
      var result = b.hardDrop();
      assert.equal(b.gridVersion, prevGV + 1,
        'lock ' + i + ': gridVersion increments exactly once');
      locks++;
      lockedSinceClear += pieceCells;
      if (result.linesCleared > 0) {
        b.tick(LINE_CLEAR_DELAY_MS + 1);
        lockedSinceClear = countCells(b.grid);
      } else {
        assert.equal(countCells(b.grid), lockedSinceClear,
          'lock ' + i + ': no orphan cells');
      }
    }
    assert.equal(locks, 20, 'all 20 hard-drops completed');
  });
});

describe('Gameplay - full loop', () => {
  it('drives 50 pieces with movement + rotation without errors', () => {
    // End-to-end play-through: move, rotate, drop. Exercises every code path
    // the player's input takes. Catches throws, infinite loops, KO from
    // legal play, or grid corruption from move/rotate/drop interactions.
    var b = new PlayerBoard('p1', 12345, 1);
    b.spawnPiece();
    var locks = 0;
    var errors = 0;
    var clears = 0;
    var maxLocks = 50;

    while (b.alive && locks < maxLocks) {
      try {
        // Deterministic per-lock actions: spread pieces across columns (so
        // the board doesn't overfill on a single column), then exercise
        // rotation paths.
        var targetCol = (locks * 3) % HEX_COLS;
        while (b.currentPiece.anchorCol > targetCol && b.moveLeft()) {}
        while (b.currentPiece.anchorCol < targetCol && b.moveRight()) {}
        if (locks % 3 === 0) b.rotateCW();
        if (locks % 7 === 0) b.rotateCCW();

        var result = b.hardDrop();
        locks++;
        if (result.linesCleared > 0) {
          clears += result.linesCleared;
          b.tick(LINE_CLEAR_DELAY_MS + 1);
        }
      } catch (e) {
        errors++;
        break;
      }
    }

    assert.equal(errors, 0, 'no errors during 50-piece play');
    // A reasonable run with input should sustain well past the first piece —
    // anything less means early KO (the bug class this test exists to catch).
    assert.ok(locks >= 20, 'should sustain at least 20 piece locks (got ' + locks + ')');
    // Grid cell count must never exceed board capacity.
    assert.ok(countCells(b.grid) <= HEX_TOTAL_ROWS * HEX_COLS,
      'cell count within board bounds (no double-lock corruption)');
    // Sanity: lines counter agrees with clears we observed.
    assert.equal(b.lines, clears, 'lines counter matches observed clears');
  });

  it('hold + rotate + soft-drop interactions stay consistent', () => {
    // Exercises the less-trodden paths: hold swap, soft drop into a rotation
    // window, hold while a piece is mid-rotation. These are easy places for
    // stale state to surface.
    var b = new PlayerBoard('p1', 99, 1);
    b.spawnPiece();
    var initialType = b.currentPiece.type;

    b.hold();
    assert.equal(b.holdPiece, initialType, 'first hold stashes the active type');
    assert.ok(b.currentPiece, 'a new piece spawned after hold');
    assert.equal(b.alive, true, 'alive after hold');

    b.rotateCW();
    b.softDropStart();
    b.tick(50);
    b.softDropEnd();
    b.rotateCCW();
    b.moveLeft();
    var result = b.hardDrop();
    assert.equal(result.alive, true, 'still alive after hold+rotate+softdrop+drop');
    // Board is empty before this drop, so a single lock can't complete any
    // zigzag — gridVersion advances by exactly 1 (the lock), no clear cascade.
    assert.equal(b.gridVersion, 1, 'exactly one lock recorded');
  });
});
