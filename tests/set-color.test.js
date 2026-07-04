'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { MSG, ROOM_STATE } = require('../public/shared/protocol');
const { PLAYER_COLORS } = require('../public/shared/theme');

// =====================================================================
// Tests for the lobby color-picker protocol (MSG.SET_COLOR).
//
// onSetColor mirrors the production handler in public/display/DisplayInput.js:
//   - Reject invalid indices (non-integer, out-of-range).
//   - Reject if another player already claims the target index.
//   - No-op if the sender already holds the target index.
//   - Not state-gated: accepted in every roomState. The controller's color
//     picker is reachable only in the lobby, so a mid-game pick can't occur in
//     practice — the handler itself imposes no lock.
//
// broadcastLobbyUpdate mirrors the production broadcaster: its outgoing
// takenColorIndices payload should reflect the post-swap state.
// =====================================================================

const PALETTE_SIZE = PLAYER_COLORS.length;

function collectTakenColorIndices(players) {
  var out = [];
  for (const entry of players) out.push(entry[1].playerIndex);
  out.sort(function(a, b) { return a - b; });
  return out;
}

function broadcastLobbyUpdate(players, playerOrder, roomState, party) {
  var takenColorIndices = collectTakenColorIndices(players);
  for (const entry of players) {
    party.sendTo(entry[0], {
      type: MSG.LOBBY_UPDATE,
      playerCount: players.size,
      colorIndex: entry[1].playerIndex,
      takenColorIndices: takenColorIndices
    });
  }
}

function nextAvailableSlot(players) {
  var used = new Set();
  for (const entry of players) used.add(entry[1].playerIndex);
  for (var i = 0; i < PALETTE_SIZE; i++) { if (!used.has(i)) return i; }
  return -1;
}

// Mirrors DisplayInput.js#onSetColor.
function onSetColor(players, playerOrder, roomState, party, fromId, msg) {
  if (!players.has(fromId)) return;
  var idx = parseInt(msg.colorIndex, 10);
  if (isNaN(idx) || idx < 0 || idx >= PALETTE_SIZE) return;

  var player = players.get(fromId);
  if (player.playerIndex === idx) return;

  for (const entry of players) {
    if (entry[0] !== fromId && entry[1].playerIndex === idx) return;
  }

  player.playerIndex = idx;
  broadcastLobbyUpdate(players, playerOrder, roomState, party);
}

function seedPlayer(players, id, playerIndex) {
  players.set(id, { playerName: id, playerIndex: playerIndex, startLevel: 1 });
}

describe('Display: onSetColor', () => {
  let players, playerOrder, roomState, sent, party;

  beforeEach(() => {
    players = new Map();
    playerOrder = [];
    roomState = ROOM_STATE.LOBBY;
    sent = [];
    party = { sendTo: (to, msg) => { sent.push({ to, msg }); } };
  });

  test('accepts an unclaimed color in LOBBY', () => {
    seedPlayer(players, 'a', 0);
    playerOrder.push('a');

    onSetColor(players, playerOrder, roomState, party, 'a', { colorIndex: 4 });
    assert.strictEqual(players.get('a').playerIndex, 4);
    // One LOBBY_UPDATE fanout, taken reflects the new slot.
    const lobbyMsgs = sent.filter(s => s.msg.type === MSG.LOBBY_UPDATE);
    assert.ok(lobbyMsgs.length >= 1);
    assert.deepStrictEqual(lobbyMsgs[0].msg.takenColorIndices, [4]);
  });

  test('rejects collision with another player', () => {
    seedPlayer(players, 'a', 0);
    seedPlayer(players, 'b', 3);
    playerOrder.push('a', 'b');

    onSetColor(players, playerOrder, roomState, party, 'a', { colorIndex: 3 });
    assert.strictEqual(players.get('a').playerIndex, 0, 'should not change on collision');
    assert.strictEqual(sent.length, 0, 'no broadcast on rejection');
  });

  test('no-op if requesting the same color already held', () => {
    seedPlayer(players, 'a', 2);
    playerOrder.push('a');

    onSetColor(players, playerOrder, roomState, party, 'a', { colorIndex: 2 });
    assert.strictEqual(players.get('a').playerIndex, 2);
    assert.strictEqual(sent.length, 0);
  });

  test('rejects invalid indices', () => {
    seedPlayer(players, 'a', 0);
    playerOrder.push('a');

    onSetColor(players, playerOrder, roomState, party, 'a', { colorIndex: -1 });
    onSetColor(players, playerOrder, roomState, party, 'a', { colorIndex: PALETTE_SIZE });
    onSetColor(players, playerOrder, roomState, party, 'a', { colorIndex: 99 });
    onSetColor(players, playerOrder, roomState, party, 'a', { colorIndex: 'red' });
    onSetColor(players, playerOrder, roomState, party, 'a', {});

    assert.strictEqual(players.get('a').playerIndex, 0);
    assert.strictEqual(sent.length, 0);
  });

  // Not state-gated: an active participant can recolor in any roomState. The
  // production picker is lobby-only so this can't happen in practice, but the
  // handler imposes no lock — covered across PLAYING/COUNTDOWN/RESULTS so a
  // re-added guard fails here.
  test('accepts a color change during PLAYING', () => {
    seedPlayer(players, 'a', 0);
    playerOrder.push('a');
    roomState = ROOM_STATE.PLAYING;

    onSetColor(players, playerOrder, roomState, party, 'a', { colorIndex: 5 });
    assert.strictEqual(players.get('a').playerIndex, 5);
    assert.ok(sent.some(s => s.msg.type === MSG.LOBBY_UPDATE), 'broadcasts the swap');
  });

  test('accepts a color change during COUNTDOWN', () => {
    seedPlayer(players, 'a', 0);
    playerOrder.push('a');
    roomState = ROOM_STATE.COUNTDOWN;

    onSetColor(players, playerOrder, roomState, party, 'a', { colorIndex: 5 });
    assert.strictEqual(players.get('a').playerIndex, 5);
  });

  test('accepts a color change during RESULTS', () => {
    seedPlayer(players, 'a', 0);
    playerOrder.push('a');
    roomState = ROOM_STATE.RESULTS;

    onSetColor(players, playerOrder, roomState, party, 'a', { colorIndex: 5 });
    assert.strictEqual(players.get('a').playerIndex, 5);
  });

  test('collision rejection still applies mid-game', () => {
    seedPlayer(players, 'a', 0);
    seedPlayer(players, 'b', 6);
    playerOrder.push('a', 'b');
    roomState = ROOM_STATE.PLAYING;

    onSetColor(players, playerOrder, roomState, party, 'a', { colorIndex: 6 });
    assert.strictEqual(players.get('a').playerIndex, 0, 'taken slot is still refused');
    assert.strictEqual(sent.length, 0);
  });

  test('ignores unknown sender', () => {
    onSetColor(players, playerOrder, roomState, party, 'ghost', { colorIndex: 0 });
    assert.strictEqual(sent.length, 0);
  });

  // The "existing controllers learn a joiner claimed a slot" guarantee moved
  // to hello-preferred-color.test.js: onPeerJoined's broadcast is now deferred
  // to the joiner's HELLO (or the paint timeout) instead of firing
  // synchronously with placeholder identity.

  test('LOBBY_UPDATE fanout tags each recipient with their own colorIndex', () => {
    seedPlayer(players, 'a', 0);
    seedPlayer(players, 'b', 1);
    playerOrder.push('a', 'b');

    onSetColor(players, playerOrder, roomState, party, 'a', { colorIndex: 7 });
    const byRecipient = new Map();
    for (const s of sent) if (s.msg.type === MSG.LOBBY_UPDATE) byRecipient.set(s.to, s.msg.colorIndex);
    assert.strictEqual(byRecipient.get('a'), 7);
    assert.strictEqual(byRecipient.get('b'), 1);
  });
});
