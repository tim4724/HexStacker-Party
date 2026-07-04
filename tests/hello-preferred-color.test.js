'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { MSG, ROOM_STATE } = require('../public/shared/protocol');
const { PLAYER_COLORS } = require('../public/shared/theme');
const { generateAutoPlayerName, sanitizePlayerName } = require('./auto-name-helper');

// =====================================================================
// Tests for the preferred color riding on HELLO and the deferred lobby
// roster paint.
//
// Production flow (web controller):
//   1. relay peer_joined -> DisplayConnection.js#onPeerJoined registers the
//      player with an HX fallback name and the default slot color, but DEFERS
//      the roster paint + LOBBY_UPDATE (pendingJoinPaints, bounded by
//      JOIN_PAINT_DEFER_MS) so the TV never flashes placeholder identity.
//   2. The controller's HELLO carries { name, colorIndex } (the persisted
//      preferred color). DisplayInput.js#onHello applies both, cancels the
//      pending paint, and paints/broadcasts once with the final identity.
//   3. WELCOME already answers with the honored color, so the controller's
//      reclaimPreferredColor SET_COLOR round trip no-ops.
// The timeout path covers a controller whose HELLO stalls; it guarantees the
// LOBBY_UPDATE that tells existing controllers a palette slot got claimed
// (previously asserted in set-color.test.js against the synchronous
// onPeerJoined broadcast).
// =====================================================================

const PALETTE_SIZE = PLAYER_COLORS.length;

function nextAvailableSlot(players) {
  var used = new Set();
  for (const entry of players) used.add(entry[1].playerIndex);
  for (var i = 0; i < PALETTE_SIZE; i++) { if (!used.has(i)) return i; }
  return -1;
}

function broadcastLobbyUpdate(room) {
  var taken = [];
  for (const entry of room.players) taken.push(entry[1].playerIndex);
  taken.sort(function(a, b) { return a - b; });
  for (const entry of room.players) {
    room.sent.push({
      to: entry[0],
      msg: {
        type: MSG.LOBBY_UPDATE,
        playerCount: room.players.size,
        colorIndex: entry[1].playerIndex,
        takenColorIndices: taken
      }
    });
  }
}

// Roster-paint stand-in for updatePlayerList/updateStartButton.
function paintRoster(room) {
  room.paints++;
  broadcastLobbyUpdate(room);
}

// Mirrors DisplayConnection.js#onPeerJoined. Production arms a
// JOIN_PAINT_DEFER_MS setTimeout; the mirror stores the callback so tests
// fire the timeout explicitly via firePendingJoinPaint.
function onPeerJoined(room, clientId) {
  if (room.players.has(clientId)) return;
  var index = nextAvailableSlot(room.players);
  if (index < 0) return;
  room.players.set(clientId, {
    playerName: generateAutoPlayerName(room.players, clientId),
    playerIndex: index,
    startLevel: 1
  });
  if (room.roomState === ROOM_STATE.LOBBY) {
    room.playerOrder.push(clientId);
    room.pendingJoinPaints.set(clientId, function () {
      room.pendingJoinPaints.delete(clientId);
      if (room.roomState !== ROOM_STATE.LOBBY || !room.players.has(clientId)) return;
      paintRoster(room);
    });
  }
}

function firePendingJoinPaint(room, clientId) {
  var timeout = room.pendingJoinPaints.get(clientId);
  if (timeout) timeout();
}

// Mirrors DisplayConnection.js#cancelPendingJoinPaint.
function cancelPendingJoinPaint(room, clientId) {
  if (!room.pendingJoinPaints.has(clientId)) return false;
  room.pendingJoinPaints.delete(clientId);
  return true;
}

// Mirrors DisplayConnection.js#onPeerLeft's slice relevant here.
function onPeerLeft(room, clientId) {
  cancelPendingJoinPaint(room, clientId);
  room.players.delete(clientId);
  room.playerOrder = room.playerOrder.filter(function(id) { return id !== clientId; });
}

// Mirrors DisplayInput.js#helloPreferredColor.
function helloPreferredColor(room, fromId, msg) {
  var idx = parseInt(msg.colorIndex, 10);
  if (isNaN(idx) || idx < 0 || idx >= PALETTE_SIZE) return null;
  for (const entry of room.players) {
    if (entry[0] !== fromId && entry[1].playerIndex === idx) return null;
  }
  return idx;
}

// Mirrors the name/color/paint slice of DisplayInput.js#onHello.
function onHello(room, fromId, msg) {
  var name = typeof msg.name === 'string' ? msg.name.trim().slice(0, 16) : '';

  if (room.players.has(fromId)) {
    var existing = room.players.get(fromId);
    if (name || msg.autoName === true) {
      existing.playerName = sanitizePlayerName(
        name || existing.playerName, room.players, fromId, msg.autoName === true);
    }
    var preferredColor = helloPreferredColor(room, fromId, msg);
    var colorChanged = preferredColor != null && existing.playerIndex !== preferredColor;
    if (colorChanged) existing.playerIndex = preferredColor;
    var joinPaintWasPending = cancelPendingJoinPaint(room, fromId);
    if (joinPaintWasPending) room.paints++;
    room.sent.push({
      to: fromId,
      msg: { type: MSG.WELCOME, playerName: existing.playerName, colorIndex: existing.playerIndex }
    });
    if (colorChanged || joinPaintWasPending) broadcastLobbyUpdate(room);
    return;
  }

  // New player (HELLO beat the relay's peer_joined).
  var index = helloPreferredColor(room, fromId, msg);
  if (index == null) index = nextAvailableSlot(room.players);
  if (index < 0) {
    room.sent.push({ to: fromId, msg: { type: MSG.ERROR, message: 'Room is full' } });
    return;
  }
  room.players.set(fromId, {
    playerName: sanitizePlayerName(name, room.players, fromId, msg.autoName === true),
    playerIndex: index,
    startLevel: 1
  });
  if (room.roomState === ROOM_STATE.LOBBY) room.playerOrder.push(fromId);
  room.sent.push({
    to: fromId,
    msg: { type: MSG.WELCOME, playerName: room.players.get(fromId).playerName, colorIndex: index }
  });
  broadcastLobbyUpdate(room);
}

function lobbyUpdatesTo(room, id) {
  return room.sent.filter(function(s) { return s.to === id && s.msg.type === MSG.LOBBY_UPDATE; });
}

function welcomeTo(room, id) {
  return room.sent.find(function(s) { return s.to === id && s.msg.type === MSG.WELCOME; });
}

describe('Display: preferred color on HELLO', () => {
  let room;

  beforeEach(() => {
    room = {
      players: new Map(),
      playerOrder: [],
      roomState: ROOM_STATE.LOBBY,
      sent: [],
      paints: 0,
      pendingJoinPaints: new Map()
    };
  });

  test('preferred color replaces the default slot for a peer_joined-registered player', () => {
    onPeerJoined(room, 'p1');
    assert.strictEqual(room.players.get('p1').playerIndex, 0, 'default slot before HELLO');

    onHello(room, 'p1', { type: MSG.HELLO, name: 'Alice', colorIndex: 5 });
    assert.strictEqual(room.players.get('p1').playerIndex, 5);
    assert.strictEqual(welcomeTo(room, 'p1').msg.colorIndex, 5,
      'WELCOME answers with the honored color, so the reclaim SET_COLOR no-ops');
  });

  test('taken preferred color keeps the assigned slot', () => {
    room.players.set('a', { playerName: 'A', playerIndex: 5, startLevel: 1 });
    onPeerJoined(room, 'b');

    onHello(room, 'b', { type: MSG.HELLO, name: 'Bob', colorIndex: 5 });
    assert.strictEqual(room.players.get('b').playerIndex, 0, 'collision falls back to the slot');
    assert.strictEqual(welcomeTo(room, 'b').msg.colorIndex, 0);
  });

  test('invalid colorIndex values are ignored', () => {
    onPeerJoined(room, 'p1');
    firePendingJoinPaint(room, 'p1');
    room.sent = [];

    for (const bad of [-1, PALETTE_SIZE, 99, 'red', null, undefined]) {
      onHello(room, 'p1', { type: MSG.HELLO, name: 'Alice', colorIndex: bad });
    }
    assert.strictEqual(room.players.get('p1').playerIndex, 0);
    assert.strictEqual(lobbyUpdatesTo(room, 'p1').length, 0, 'no broadcast without a change');
  });

  test('HELLO-beats-peer_joined path assigns the preferred color directly', () => {
    onHello(room, 'p1', { type: MSG.HELLO, name: 'Alice', colorIndex: 3 });
    assert.strictEqual(room.players.get('p1').playerIndex, 3);
    assert.strictEqual(welcomeTo(room, 'p1').msg.colorIndex, 3);
  });

  test('preferred color equal to the assigned slot produces no extra broadcast', () => {
    onPeerJoined(room, 'p1');
    firePendingJoinPaint(room, 'p1');
    room.sent = [];

    onHello(room, 'p1', { type: MSG.HELLO, name: 'Alice', colorIndex: 0 });
    assert.strictEqual(lobbyUpdatesTo(room, 'p1').length, 0);
  });

  test('color change after a flushed paint still broadcasts to existing controllers', () => {
    room.players.set('a', { playerName: 'A', playerIndex: 1, startLevel: 1 });
    onPeerJoined(room, 'b');
    firePendingJoinPaint(room, 'b');
    room.sent = [];

    onHello(room, 'b', { type: MSG.HELLO, name: 'Bob', colorIndex: 6 });
    const updates = lobbyUpdatesTo(room, 'a');
    assert.strictEqual(updates.length, 1, 'a learns that slot 6 got claimed');
    assert.deepStrictEqual(updates[0].msg.takenColorIndices, [1, 6]);
  });
});

describe('Display: deferred lobby roster paint', () => {
  let room;

  beforeEach(() => {
    room = {
      players: new Map(),
      playerOrder: [],
      roomState: ROOM_STATE.LOBBY,
      sent: [],
      paints: 0,
      pendingJoinPaints: new Map()
    };
    room.players.set('a', { playerName: 'A', playerIndex: 0, startLevel: 1 });
    room.playerOrder.push('a');
  });

  test('peer_joined registers but does not paint or broadcast immediately', () => {
    onPeerJoined(room, 'b');
    assert.strictEqual(room.players.has('b'), true, 'registered (slot + host stickiness)');
    assert.strictEqual(room.paints, 0);
    assert.strictEqual(room.sent.length, 0, 'no LOBBY_UPDATE with placeholder identity');
    assert.strictEqual(room.pendingJoinPaints.has('b'), true);
  });

  test('HELLO cancels the pending paint and paints/broadcasts once', () => {
    onPeerJoined(room, 'b');
    onHello(room, 'b', { type: MSG.HELLO, name: 'Bob', colorIndex: 4 });

    assert.strictEqual(room.pendingJoinPaints.has('b'), false);
    assert.strictEqual(room.paints, 1);
    const updates = lobbyUpdatesTo(room, 'a');
    assert.strictEqual(updates.length, 1, 'exactly one broadcast, with the final identity');
    assert.deepStrictEqual(updates[0].msg.takenColorIndices, [0, 4]);
  });

  test('timeout paints when HELLO stalls, so the join is never silently hidden', () => {
    onPeerJoined(room, 'b');
    firePendingJoinPaint(room, 'b');

    assert.strictEqual(room.paints, 1);
    assert.strictEqual(lobbyUpdatesTo(room, 'a').length, 1,
      'existing controllers learn the claimed slot even without a HELLO');
    assert.strictEqual(room.pendingJoinPaints.has('b'), false);
  });

  test('timeout after leaving the lobby state does not paint', () => {
    onPeerJoined(room, 'b');
    room.roomState = ROOM_STATE.COUNTDOWN;
    firePendingJoinPaint(room, 'b');
    assert.strictEqual(room.paints, 0);
    assert.strictEqual(room.sent.length, 0);
  });

  test('peer leaving inside the defer window cancels the pending paint', () => {
    onPeerJoined(room, 'b');
    onPeerLeft(room, 'b');
    assert.strictEqual(room.pendingJoinPaints.has('b'), false);
    firePendingJoinPaint(room, 'b');
    assert.strictEqual(room.paints, 0, 'no paint for a departed player');
  });
});
