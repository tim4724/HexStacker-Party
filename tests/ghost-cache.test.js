'use strict';

// Regression: PlayerBoard._ghostOf must key on piece TYPE, not just
// col/row/rot/gridVersion. hold() swaps the current piece's type WITHOUT bumping
// gridVersion, so a same-anchor/rotation cache hit used to hand back the previous
// type's ghost — wrong visually and, because hardDrop() routes through _ghostOf,
// a wrong-typed lock.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PlayerBoard } = require('../server/PlayerBoard');
const { Piece } = require('../server/Piece');

test('_ghostOf keys on piece type: a same-position type swap cannot return a stale ghost', () => {
  const b = new PlayerBoard('p', 42, 1);
  b.spawnPiece();
  const a = b.currentPiece;

  // Populate the ghost cache for the current (type A) piece at its spawn key.
  const ghostA = b._ghostOf(a);
  assert.equal(ghostA.typeId, a.typeId);

  // Build a differently-typed piece at the SAME anchor/rotation while gridVersion
  // is unchanged — exactly the shape hold() produces. The old key (col/row/rot/GV)
  // would stale-hit and return ghost A.
  const otherType = b.nextPieces.find((t) => new Piece(t).typeId !== a.typeId);
  assert.ok(otherType != null, 'queue should contain a differently-typed piece');
  const other = new Piece(otherType);
  other.anchorCol = b._ghostKeyCol;
  other.anchorRow = b._ghostKeyRow;
  other._rotId = b._ghostKeyRot;

  const ghost = b._ghostOf(other);
  assert.equal(ghost.typeId, other.typeId,
    'ghost must reflect the current piece type, not a stale cached ghost');
});

test('hold() then hardDrop locks the held piece type, not the pre-hold type', () => {
  const b = new PlayerBoard('p', 42, 1);
  b.spawnPiece();
  const preHoldType = b.currentPiece.typeId;

  b.hold();
  const heldType = b.currentPiece.typeId;

  b.hardDrop(); // routes through _ghostOf; must drop the held piece

  // The locked cells in the grid must carry the held piece's typeId, never the
  // pre-hold type. (When hold swaps to the same type the assertion is trivially
  // satisfied; the bug only ever mislabeled a *different* type.)
  const locked = new Set();
  for (const row of b.grid) for (const cell of row) if (cell !== 0) locked.add(cell);
  assert.ok(locked.size > 0, 'hardDrop should have locked cells');
  assert.ok(locked.has(heldType), 'locked cells carry the held piece type');
  if (heldType !== preHoldType) {
    assert.ok(!locked.has(preHoldType), 'no cell carries the stale pre-hold type');
  }
});
