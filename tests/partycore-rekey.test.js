'use strict';

// PartyCore.rekeyPlayer() unit coverage through the PARTYCORE surface — the
// exact call the native bridges make on a cross-device claim (a returning
// controller reclaims a dropped participant's board). The Game-level mechanics
// live in tests/rekey-player.test.js; this file pins the PartyCore delegation
// and the snapshot-visible effects the native hosts rely on. Mirrors
// partyplug/RoomFlow.rekey on the roster side.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PartyCore } = require('../server/PartyCore');

function newCore() {
  const roster = new Map([['p1', { startLevel: 1 }], ['p2', { startLevel: 1 }]]);
  const pc = new PartyCore(roster, 12345);
  pc.init();
  return pc;
}

const ids = (pc) => pc.snapshot().players.map((p) => p.id);

test('rekeyPlayer moves a board to the new id, preserving player order', () => {
  const pc = newCore();
  assert.deepEqual(ids(pc), ['p1', 'p2']);

  assert.equal(pc.rekeyPlayer('p1', 'p9'), true, 'returns true when a board moved');

  assert.deepEqual(ids(pc), ['p9', 'p2'], 'p1 -> p9, order preserved');
  assert.equal(pc.game.boards.has('p9'), true, 'board is now keyed by the new id');
  assert.equal(pc.game.boards.has('p1'), false, 'old id no longer keys a board');
  assert.ok(pc.game.playerIds.includes('p9') && !pc.game.playerIds.includes('p1'));
});

test('rekeyPlayer is a no-op for unknown, identical, or already-owned ids', () => {
  const pc = newCore();
  assert.equal(pc.rekeyPlayer('nope', 'p9'), false, 'unknown oldId -> false, no change');
  assert.equal(pc.rekeyPlayer('p1', 'p1'), false, 'oldId === newId -> false, no change');
  // Forged-claim guard: an id that already owns a board can't absorb another.
  assert.equal(pc.rekeyPlayer('p1', 'p2'), false, 'newId owns a board -> refused');
  assert.deepEqual(ids(pc), ['p1', 'p2'], 'roster untouched');
});
