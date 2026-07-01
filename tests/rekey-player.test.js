'use strict';

// Game/PartyCore.rekeyPlayer: a cross-device mid-game rejoin moves a player's
// board, id ordering, hard-drop cooldown and garbage queues from the dropped
// peer index to the returning one, without perturbing anyone else's state. Used
// by the native displays (tvOS / Android TV) to honor the ?claim= rejoin QR.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PartyCore } = require('../server/PartyCore');

function makeCore() {
  const players = new Map([
    [1, { startLevel: 1 }],
    [2, { startLevel: 1 }],
  ]);
  const core = new PartyCore(players, 0xC0FFEE);
  core.init();
  return core;
}

test('rekeyPlayer moves the board + ordering to the new id, preserving position', () => {
  const core = makeCore();
  const before = core.snapshot();
  const board1Before = JSON.stringify(before.players.find((p) => p.id === 1));

  assert.equal(core.rekeyPlayer(1, 9), true);

  const after = core.snapshot();
  const ids = after.players.map((p) => p.id);
  assert.deepEqual(ids, [9, 2], 'id 1 -> 9, order (and so board position) preserved');

  // The re-keyed board is the SAME board state, just under the new id.
  const board9 = after.players.find((p) => p.id === 9);
  const rebadged = JSON.parse(board1Before);
  rebadged.id = 9;
  assert.deepEqual(board9, rebadged, 'board state carried over intact');
});

test('rekeyPlayer routes the returning peer\'s input to the kept board', () => {
  const core = makeCore();
  core.rekeyPlayer(1, 9);
  // Input under the OLD id is now a no-op; input under the NEW id drives the board.
  core.processInput(1, 'hard_drop');   // ignored (no board 1)
  const a = core.snapshot().players.find((p) => p.id === 9);
  core.processInput(9, 'hard_drop');   // locks a piece on the kept board
  core.update(16);
  const b = core.snapshot().players.find((p) => p.id === 9);
  assert.notDeepEqual(a.grid, b.grid, 'hard_drop under the new id mutated the board');
});

test('rekeyPlayer is a no-op for an unknown or unchanged id', () => {
  const core = makeCore();
  assert.equal(core.rekeyPlayer(1, 1), false, 'same id');
  assert.equal(core.rekeyPlayer(42, 7), false, 'unknown old id');
  assert.deepEqual(core.snapshot().players.map((p) => p.id), [1, 2], 'roster untouched');
});

test('rekeyPlayer leaves other players untouched', () => {
  const core = makeCore();
  const p2Before = JSON.stringify(core.snapshot().players.find((p) => p.id === 2));
  core.rekeyPlayer(1, 9);
  const p2After = JSON.stringify(core.snapshot().players.find((p) => p.id === 2));
  assert.equal(p2After, p2Before, 'the other board is byte-identical');
});
