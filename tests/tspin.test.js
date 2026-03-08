'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { detectTSpin, PlayerBoard } = require('../server/PlayerBoard');

// Helper: create an empty grid
function emptyGrid(width, height) {
  return Array.from({ length: height }, () => new Array(width).fill(0));
}

describe('detectTSpin - pure function', () => {
  const W = 10, H = 24;

  test('returns no T-spin for non-T piece', () => {
    const grid = emptyGrid(W, H);
    const result = detectTSpin(grid, 'I', 3, 0, 0);
    assert.deepStrictEqual(result, { isTSpin: false, isTSpinMini: false });
  });

  test('returns no T-spin when fewer than 3 corners filled', () => {
    const grid = emptyGrid(W, H);
    // T piece at (4, 10) rotation 0 — all corners empty
    const result = detectTSpin(grid, 'T', 4, 10, 0);
    assert.deepStrictEqual(result, { isTSpin: false, isTSpinMini: false });
  });

  test('returns no T-spin with exactly 2 filled corners', () => {
    const grid = emptyGrid(W, H);
    // Fill 2 corners around T at (4, 10): corners at (4,10), (6,10), (4,12), (6,12)
    // Center is (5, 11)
    grid[10][4] = 1; // top-left
    grid[10][6] = 1; // top-right
    const result = detectTSpin(grid, 'T', 4, 10, 0);
    assert.deepStrictEqual(result, { isTSpin: false, isTSpinMini: false });
  });

  test('detects full T-spin when both front corners filled (rotation 0)', () => {
    const grid = emptyGrid(W, H);
    // T at (4, 10), rotation 0: front corners are top-left (4,10) and top-right (6,10)
    // Center (5, 11)
    grid[10][4] = 1; // top-left (front)
    grid[10][6] = 1; // top-right (front)
    grid[12][4] = 1; // bottom-left (back)
    const result = detectTSpin(grid, 'T', 4, 10, 0);
    assert.strictEqual(result.isTSpin, true);
    assert.strictEqual(result.isTSpinMini, false);
  });

  test('detects T-spin mini when only one front corner filled (rotation 0)', () => {
    const grid = emptyGrid(W, H);
    // T at (4, 10), rotation 0: front = top-left (4,10), top-right (6,10)
    // Fill 3 corners but only 1 front
    grid[10][4] = 1; // top-left (front)
    grid[12][4] = 1; // bottom-left (back)
    grid[12][6] = 1; // bottom-right (back)
    const result = detectTSpin(grid, 'T', 4, 10, 0);
    assert.strictEqual(result.isTSpin, false);
    assert.strictEqual(result.isTSpinMini, true);
  });

  test('detects full T-spin at rotation 1', () => {
    const grid = emptyGrid(W, H);
    // T at (4, 10), rotation 1: front corners are (6,10) and (6,12)
    // Center (5, 11)
    grid[10][6] = 1; // top-right (front)
    grid[12][6] = 1; // bottom-right (front)
    grid[10][4] = 1; // top-left (back)
    const result = detectTSpin(grid, 'T', 4, 10, 1);
    assert.strictEqual(result.isTSpin, true);
    assert.strictEqual(result.isTSpinMini, false);
  });

  test('detects full T-spin at rotation 2', () => {
    const grid = emptyGrid(W, H);
    // T at (4, 10), rotation 2: front corners are (6,12) and (4,12)
    // Center (5, 11)
    grid[12][6] = 1; // bottom-right (front)
    grid[12][4] = 1; // bottom-left (front)
    grid[10][4] = 1; // top-left (back)
    const result = detectTSpin(grid, 'T', 4, 10, 2);
    assert.strictEqual(result.isTSpin, true);
    assert.strictEqual(result.isTSpinMini, false);
  });

  test('detects full T-spin at rotation 3', () => {
    const grid = emptyGrid(W, H);
    // T at (4, 10), rotation 3: front corners are (4,12) and (4,10)
    // Center (5, 11)
    grid[12][4] = 1; // bottom-left (front)
    grid[10][4] = 1; // top-left (front)
    grid[12][6] = 1; // bottom-right (back)
    const result = detectTSpin(grid, 'T', 4, 10, 3);
    assert.strictEqual(result.isTSpin, true);
    assert.strictEqual(result.isTSpinMini, false);
  });

  test('boundary counts as filled corner (piece near top of grid)', () => {
    const grid = emptyGrid(W, H);
    // T at x=4, y=-1 (possible during detection even if invalid placement):
    // center at (5, 0). Corners: (4,-1)=OOB, (6,-1)=OOB, (4,1), (6,1)
    // 2 OOB corners + 1 filled grid cell = 3 filled
    grid[1][4] = 1; // bottom-left corner
    // Rotation 0: front = (4,-1)=OOB, (6,-1)=OOB → both front filled
    const result = detectTSpin(grid, 'T', 4, -1, 0);
    assert.strictEqual(result.isTSpin, true);
  });

  test('floor counts as filled corner (piece at bottom)', () => {
    const grid = emptyGrid(W, H);
    // T at (4, 22): center at (5, 23), bottom corners at row 24 = out of bounds
    // Corners: (4,22), (6,22), (4,24)=floor, (6,24)=floor
    grid[22][4] = 1; // top-left
    // 2 floor + 1 filled = 3 corners
    // Rotation 2: front = (6,24)=floor, (4,24)=floor → both front filled
    const result = detectTSpin(grid, 'T', 4, 22, 2);
    assert.strictEqual(result.isTSpin, true);
  });

  test('all 4 corners filled is full T-spin regardless of rotation', () => {
    const grid = emptyGrid(W, H);
    // Fill all 4 corners around T at (4, 10)
    grid[10][4] = 1;
    grid[10][6] = 1;
    grid[12][4] = 1;
    grid[12][6] = 1;
    for (var rot = 0; rot < 4; rot++) {
      const result = detectTSpin(grid, 'T', 4, 10, rot);
      assert.strictEqual(result.isTSpin, true, 'rotation ' + rot);
      assert.strictEqual(result.isTSpinMini, false, 'rotation ' + rot);
    }
  });
});

describe('detectTSpin - integration with PlayerBoard', () => {
  test('PlayerBoard._checkTSpin uses detectTSpin correctly', () => {
    const board = new PlayerBoard('test', 42);
    // Set up a T-spin: T piece at (4, 10), rotation 0
    // Center at (5, 11). Fill 3 corners with both front corners filled.
    // Front corners for rotation 0: (4,10) and (6,10)
    board.grid[10][4] = 1; // top-left (front)
    board.grid[10][6] = 1; // top-right (front)
    board.grid[12][4] = 1; // bottom-left (back)

    const { Piece } = require('../server/Piece');
    board.currentPiece = new Piece('T');
    board.currentPiece.x = 4;
    board.currentPiece.y = 10;
    board.currentPiece.rotation = 0;

    board._checkTSpin();
    assert.strictEqual(board.lastWasTSpin, true);
    assert.strictEqual(board.lastWasTSpinMini, false);
  });

  test('PlayerBoard._checkTSpin detects mini correctly', () => {
    const board = new PlayerBoard('test', 42);
    // T piece at (4, 10), rotation 0
    // Fill 3 corners with only 1 front corner → T-spin mini
    board.grid[10][4] = 1; // top-left (front)
    board.grid[12][4] = 1; // bottom-left (back)
    board.grid[12][6] = 1; // bottom-right (back)

    const { Piece } = require('../server/Piece');
    board.currentPiece = new Piece('T');
    board.currentPiece.x = 4;
    board.currentPiece.y = 10;
    board.currentPiece.rotation = 0;

    board._checkTSpin();
    assert.strictEqual(board.lastWasTSpin, false);
    assert.strictEqual(board.lastWasTSpinMini, true);
  });

  test('PlayerBoard._checkTSpin ignores non-T pieces', () => {
    const board = new PlayerBoard('test', 42);
    const { Piece } = require('../server/Piece');
    board.currentPiece = new Piece('I');
    board.currentPiece.x = 4;
    board.currentPiece.y = 10;

    board._checkTSpin();
    assert.strictEqual(board.lastWasTSpin, false);
    assert.strictEqual(board.lastWasTSpinMini, false);
  });
});
