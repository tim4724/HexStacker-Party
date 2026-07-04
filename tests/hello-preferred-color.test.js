'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { MSG, ROOM_STATE } = require('../public/shared/protocol');
const { PLAYER_COLORS } = require('../public/shared/theme');
const { generateAutoPlayerName, sanitizePlayerName } = require('./auto-name-helper');

// =====================================================================
// Tests for the preferred color riding on HELLO.
//
// Production flow (web controller):
//   1. relay peer_joined -> DisplayConnection.js#onPeerJoined registers the
//      player with an HX fallback name and the default slot color.
//   2. The controller's HELLO carries { name, colorIndex } (the persisted
//      preferred color). DisplayInput.js#onHello applies both and broadcasts
//      when the color changed.
//   3. WELCOME already answers with the honored color, so the controller's
//      reclaimPreferredColor SET_COLOR round trip no-ops and the controller
//      never renders the default slot color.
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

// Mirrors DisplayConnection.js#onPeerJoined (roster registration only).
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
    broadcastLobbyUpdate(room);
  }
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

// Mirrors the name/color slice of DisplayInput.js#onHello.
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
    room.sent.push({
      to: fromId,
      msg: { type: MSG.WELCOME, playerName: existing.playerName, colorIndex: existing.playerIndex }
    });
    if (colorChanged) broadcastLobbyUpdate(room);
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
    };
  });

  test('preferred color replaces the default slot for a peer_joined-registered player', () => {
    onPeerJoined(room, 'p1');
    assert.strictEqual(room.players.get('p1').playerIndex, 0, 'default slot before HELLO');
    room.sent = [];

    onHello(room, 'p1', { type: MSG.HELLO, name: 'Alice', colorIndex: 5 });
    assert.strictEqual(room.players.get('p1').playerIndex, 5);
    assert.strictEqual(welcomeTo(room, 'p1').msg.colorIndex, 5,
      'WELCOME answers with the honored color, so the reclaim SET_COLOR no-ops');
  });

  test('taken preferred color keeps the assigned slot', () => {
    room.players.set('a', { playerName: 'A', playerIndex: 5, startLevel: 1 });
    onPeerJoined(room, 'b');
    room.sent = [];

    onHello(room, 'b', { type: MSG.HELLO, name: 'Bob', colorIndex: 5 });
    assert.strictEqual(room.players.get('b').playerIndex, 0, 'collision falls back to the slot');
    assert.strictEqual(welcomeTo(room, 'b').msg.colorIndex, 0);
    assert.strictEqual(lobbyUpdatesTo(room, 'a').length, 0, 'no broadcast on rejection');
  });

  test('invalid colorIndex values are ignored', () => {
    onPeerJoined(room, 'p1');
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
    room.sent = [];

    onHello(room, 'p1', { type: MSG.HELLO, name: 'Alice', colorIndex: 0 });
    assert.strictEqual(lobbyUpdatesTo(room, 'p1').length, 0);
  });

  test('honored color broadcasts so existing controllers grey out the swatch', () => {
    room.players.set('a', { playerName: 'A', playerIndex: 1, startLevel: 1 });
    onPeerJoined(room, 'b');
    room.sent = [];

    onHello(room, 'b', { type: MSG.HELLO, name: 'Bob', colorIndex: 6 });
    const updates = lobbyUpdatesTo(room, 'a');
    assert.strictEqual(updates.length, 1, 'a learns that slot 6 got claimed');
    assert.deepStrictEqual(updates[0].msg.takenColorIndices, [1, 6]);
  });
});
