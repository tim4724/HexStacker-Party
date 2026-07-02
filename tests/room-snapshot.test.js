'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// =====================================================================
// Retained room-snapshot migration: the display publishes ONE roster
// snapshot via party.setState() in place of the per-recipient LOBBY_UPDATE
// fanout, and each controller derives the same global lobby fields from it.
//
// These mirror the production logic (kept in lockstep with the source):
//   buildRoomSnapshot   -> public/display/DisplayConnection.js
//   deriveFromSnapshot  -> public/controller/ControllerGame.js#onState
//   legacyLobbyUpdateTo -> the OLD public/display/DisplayConnection.js#sendLobbyUpdateTo
//
// The core property under test: for any roster, the snapshot round-trips to
// exactly the global fields the old fanout sent each recipient — EXCEPT
// startLevel, which is per-recipient and deliberately stays on the targeted
// LOBBY_UPDATE (SET_LEVEL) path so a level tweak never fans out to everyone.
// =====================================================================

// --- Production mirror: display side --------------------------------------

function buildRoomSnapshot(players, hostPeerIndex) {
  var roster = {};
  for (const entry of players) {
    var p = entry[1];
    roster[entry[0]] = { name: p.playerName, color: p.playerIndex };
  }
  return { hostPeerIndex: hostPeerIndex, players: roster };
}

// The OLD per-recipient payload (sendLobbyUpdateTo), for parity assertions.
function legacyLobbyUpdateTo(players, hostPeerIndex, id) {
  var player = players.get(id);
  var hostPlayer = hostPeerIndex != null ? players.get(hostPeerIndex) : null;
  var taken = [];
  for (const entry of players) taken.push(entry[1].playerIndex);
  taken.sort(function (a, b) { return a - b; });
  return {
    playerCount: players.size,
    startLevel: player.startLevel || 1, // per-recipient — NOT in the snapshot
    isHost: id === hostPeerIndex,
    hostName: hostPlayer ? hostPlayer.playerName : null,
    hostColorIndex: hostPlayer ? hostPlayer.playerIndex : null,
    colorIndex: player.playerIndex,
    takenColorIndices: taken,
  };
}

// --- Production mirror: controller side (onState's transform) --------------

function deriveFromSnapshot(snap, peerIndex) {
  var roster = snap.players;
  var ids = Object.keys(roster);
  var colors = [];
  for (var i = 0; i < ids.length; i++) {
    var c = roster[ids[i]].color;
    if (typeof c === 'number') colors.push(c);
  }
  colors.sort(function (a, b) { return a - b; });
  var hostIdx = snap.hostPeerIndex;
  var hostEntry = hostIdx != null ? roster[hostIdx] : null;
  var mine = peerIndex != null ? roster[peerIndex] : null;
  return {
    playerCount: ids.length,
    colorIndex: mine ? mine.color : undefined,
    takenColorIndices: colors,
    isHost: (peerIndex != null && hostIdx != null) ? (peerIndex === hostIdx) : undefined,
    hostName: hostEntry ? hostEntry.name : null,
    hostColorIndex: hostEntry ? hostEntry.color : null,
  };
}

function makeRoster(entries) {
  // entries: [[peerIndex, { playerName, playerIndex, startLevel }], ...]
  return new Map(entries);
}

describe('room snapshot: display builder', () => {
  test('encodes the roster keyed by peerIndex with name + color, plus host', () => {
    const players = makeRoster([
      [1, { playerName: 'Ann', playerIndex: 2, startLevel: 5 }],
      [3, { playerName: 'Bo', playerIndex: 0, startLevel: 1 }],
    ]);
    assert.deepEqual(buildRoomSnapshot(players, 1), {
      hostPeerIndex: 1,
      players: {
        1: { name: 'Ann', color: 2 },
        3: { name: 'Bo', color: 0 },
      },
    });
  });

  test('omits per-recipient startLevel (stays on the targeted path)', () => {
    const players = makeRoster([[1, { playerName: 'Ann', playerIndex: 2, startLevel: 9 }]]);
    const snap = buildRoomSnapshot(players, 1);
    assert.equal('startLevel' in snap.players[1], false);
  });

  test('an emptied lobby publishes an honest empty roster (no departed ghost / stale host)', () => {
    // When the last lobby player leaves, the display republishes so the relay
    // never replays a snapshot naming a player who is gone.
    const snap = buildRoomSnapshot(makeRoster([]), null);
    assert.deepEqual(snap, { hostPeerIndex: null, players: {} });
    // ...and a (re)joiner derives a clean slate from it, deferring identity to WELCOME.
    const derived = deriveFromSnapshot(snap, 1);
    assert.equal(derived.playerCount, 0);
    assert.deepEqual(derived.takenColorIndices, []);
    assert.equal(derived.hostName, null);
    assert.equal(derived.isHost, undefined); // no host pointer -> left for WELCOME
  });

  test('stays tiny — a full 9-player room is far under the 16 KiB relay cap', () => {
    const entries = [];
    for (let i = 1; i <= 9; i++) entries.push([i, { playerName: 'Player-' + i, playerIndex: i - 1, startLevel: 1 }]);
    const snap = buildRoomSnapshot(makeRoster(entries), 1);
    assert.ok(Buffer.byteLength(JSON.stringify(snap)) < 16 * 1024);
  });
});

describe('room snapshot: controller derivation parity', () => {
  test('derives exactly the old fanout fields (except per-recipient startLevel)', () => {
    const players = makeRoster([
      [1, { playerName: 'Ann', playerIndex: 2, startLevel: 5 }],
      [3, { playerName: 'Bo', playerIndex: 0, startLevel: 7 }],
      [4, { playerName: 'Cy', playerIndex: 5, startLevel: 1 }],
    ]);
    const hostPeerIndex = 1;
    const snap = buildRoomSnapshot(players, hostPeerIndex);

    // Every recipient derives the same globals the old per-recipient
    // LOBBY_UPDATE carried them — minus startLevel.
    for (const id of players.keys()) {
      const derived = deriveFromSnapshot(snap, id);
      const legacy = legacyLobbyUpdateTo(players, hostPeerIndex, id);
      delete legacy.startLevel; // intentionally not globalized
      assert.deepEqual(derived, legacy, 'parity for peer ' + id);
    }
  });

  test('non-host derives isHost=false; host derives isHost=true', () => {
    const players = makeRoster([
      [1, { playerName: 'Ann', playerIndex: 2, startLevel: 1 }],
      [3, { playerName: 'Bo', playerIndex: 0, startLevel: 1 }],
    ]);
    const snap = buildRoomSnapshot(players, 1);
    assert.equal(deriveFromSnapshot(snap, 1).isHost, true);
    assert.equal(deriveFromSnapshot(snap, 3).isHost, false);
    // host name/color always resolve from the host's roster entry
    assert.equal(deriveFromSnapshot(snap, 3).hostName, 'Ann');
    assert.equal(deriveFromSnapshot(snap, 3).hostColorIndex, 2);
  });

  test('a color pick is reflected back to the picker via the roster', () => {
    // Ann picks color 4; the display updates the roster and republishes.
    const players = makeRoster([[1, { playerName: 'Ann', playerIndex: 4, startLevel: 1 }]]);
    const snap = buildRoomSnapshot(players, 1);
    assert.equal(deriveFromSnapshot(snap, 1).colorIndex, 4);
    assert.deepEqual(deriveFromSnapshot(snap, 1).takenColorIndices, [4]);
  });

  test('before our HELLO lands we are absent from the roster — colorIndex stays undefined', () => {
    // peer 9 just joined; the display has not processed its HELLO yet, so the
    // replayed snapshot has the other players but not us. onLobbyUpdate's
    // `!= null` guard then leaves our identity for WELCOME to settle.
    const players = makeRoster([[1, { playerName: 'Ann', playerIndex: 2, startLevel: 1 }]]);
    const snap = buildRoomSnapshot(players, 1);
    const derived = deriveFromSnapshot(snap, 9);
    assert.equal(derived.colorIndex, undefined);
    assert.equal(derived.playerCount, 1); // self not yet counted; WELCOME corrects
    assert.equal(derived.isHost, false);
  });
});

// =====================================================================
// Production lockstep drift guard
// =====================================================================
// The three functions above are hand-copied MIRRORS of production logic (see
// the header). Nothing structural forces them to track the source, so this
// guard reads the REAL production files and asserts that each mirror's
// load-bearing lines still appear in BOTH the production source AND the
// mirror's own body. If production changes a mirrored line without this test
// being updated (or vice versa), the fragment stops matching one side and the
// guard fails, catching silent drift while the value-parity tests above stay
// green.
//
// Robustness: fragments are matched after stripping line comments and ALL
// whitespace, so cosmetic reformatting (indentation, `function (a,b)` vs
// `function(a,b)`) never trips the guard, but any token/logic change does.
// Fragments are chosen from lines that are token-identical on both sides;
// lines that differ only in wiring (the mirror takes `hostPeerIndex` as an arg
// where production calls `getHostPeerIndex()`, or writes `x != null` where
// production writes `(x != null)`) are left out and covered indirectly by an
// adjacent identical line, so the guard stays strict without pinning cosmetics.

function stripToTokens(src) {
  return src.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, '');
}

const DISPLAY_SRC = stripToTokens(
  fs.readFileSync(path.join(__dirname, '..', 'public', 'display', 'DisplayConnection.js'), 'utf8')
);
const CONTROLLER_SRC = stripToTokens(
  fs.readFileSync(path.join(__dirname, '..', 'public', 'controller', 'ControllerGame.js'), 'utf8')
);

// Each entry pins a mirror to the production function it claims to copy. Every
// fragment must appear (token-normalized) in BOTH the mirror's own source and
// the production file.
const LOCKSTEP = [
  {
    what: 'buildRoomSnapshot mirrors DisplayConnection.js#buildRoomSnapshot',
    mirror: buildRoomSnapshot,
    prod: DISPLAY_SRC,
    fragments: [
      'roster[entry[0]] = { name: p.playerName, color: p.playerIndex };',
      'players: roster };',
    ],
  },
  {
    what: 'deriveFromSnapshot mirrors ControllerGame.js#onState',
    mirror: deriveFromSnapshot,
    prod: CONTROLLER_SRC,
    fragments: [
      'var roster = snap.players;',
      'var ids = Object.keys(roster);',
      'var c = roster[ids[i]].color;',
      "if (typeof c === 'number') colors.push(c);",
      'colors.sort(function(a, b) { return a - b; });',
      'var hostIdx = snap.hostPeerIndex;',
      'playerCount: ids.length,',
      'colorIndex: mine ? mine.color : undefined,',
      'takenColorIndices: colors,',
      'isHost: (peerIndex != null && hostIdx != null) ? (peerIndex === hostIdx) : undefined,',
      'hostName: hostEntry ? hostEntry.name : null,',
      'hostColorIndex: hostEntry ? hostEntry.color : null',
    ],
  },
  {
    what: 'legacyLobbyUpdateTo mirrors DisplayConnection.js#sendLobbyUpdateTo',
    mirror: legacyLobbyUpdateTo,
    prod: DISPLAY_SRC,
    fragments: [
      'playerCount: players.size,',
      'startLevel: player.startLevel || 1,',
      'hostName: hostPlayer ? hostPlayer.playerName : null,',
      'hostColorIndex: hostPlayer ? hostPlayer.playerIndex : null,',
      'colorIndex: player.playerIndex,',
    ],
  },
];

describe('room snapshot: production lockstep guard', () => {
  for (const { what, mirror, prod, fragments } of LOCKSTEP) {
    const mirrorSrc = stripToTokens(mirror.toString());
    for (const fragment of fragments) {
      test(`${what}: "${fragment}"`, () => {
        const needle = stripToTokens(fragment);
        assert.ok(
          mirrorSrc.includes(needle),
          'the test mirror no longer contains this asserted line; update the fragment list'
        );
        assert.ok(
          prod.includes(needle),
          'production source no longer contains this mirrored line; the test mirror is stale'
        );
      });
    }
  }
});
