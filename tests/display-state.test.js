'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { sanitizePlayerName } = require('./auto-name-helper');

// Load protocol for ROOM_STATE
const { ROOM_STATE, MSG, INPUT } = require('../public/shared/protocol');

// Simulate the minimal globals that DisplayState.js functions depend on
const GameConstants = require('../server/constants');

// =========================================================================
// setRoomState — room state machine
// =========================================================================

// Recreate the state machine from DisplayState.js
const VALID_TRANSITIONS = {};
VALID_TRANSITIONS[ROOM_STATE.LOBBY] = [ROOM_STATE.COUNTDOWN];
VALID_TRANSITIONS[ROOM_STATE.COUNTDOWN] = [ROOM_STATE.PLAYING, ROOM_STATE.LOBBY];
VALID_TRANSITIONS[ROOM_STATE.PLAYING] = [ROOM_STATE.RESULTS, ROOM_STATE.LOBBY];
VALID_TRANSITIONS[ROOM_STATE.RESULTS] = [ROOM_STATE.COUNTDOWN, ROOM_STATE.LOBBY];

function createStateMachine(initialState) {
  let roomState = initialState || ROOM_STATE.LOBBY;
  return {
    get state() { return roomState; },
    transition(newState) {
      if (newState === roomState) return true;
      const allowed = VALID_TRANSITIONS[roomState];
      if (!allowed || allowed.indexOf(newState) < 0) return false;
      roomState = newState;
      return true;
    }
  };
}

describe('Room state machine', () => {
  it('starts in LOBBY', () => {
    const sm = createStateMachine();
    assert.equal(sm.state, ROOM_STATE.LOBBY);
  });

  it('allows LOBBY → COUNTDOWN', () => {
    const sm = createStateMachine();
    assert.ok(sm.transition(ROOM_STATE.COUNTDOWN));
    assert.equal(sm.state, ROOM_STATE.COUNTDOWN);
  });

  it('allows COUNTDOWN → PLAYING', () => {
    const sm = createStateMachine(ROOM_STATE.COUNTDOWN);
    assert.ok(sm.transition(ROOM_STATE.PLAYING));
    assert.equal(sm.state, ROOM_STATE.PLAYING);
  });

  it('allows PLAYING → RESULTS', () => {
    const sm = createStateMachine(ROOM_STATE.PLAYING);
    assert.ok(sm.transition(ROOM_STATE.RESULTS));
    assert.equal(sm.state, ROOM_STATE.RESULTS);
  });

  it('allows RESULTS → COUNTDOWN (play again)', () => {
    const sm = createStateMachine(ROOM_STATE.RESULTS);
    assert.ok(sm.transition(ROOM_STATE.COUNTDOWN));
    assert.equal(sm.state, ROOM_STATE.COUNTDOWN);
  });

  it('allows RESULTS → LOBBY (new game)', () => {
    const sm = createStateMachine(ROOM_STATE.RESULTS);
    assert.ok(sm.transition(ROOM_STATE.LOBBY));
    assert.equal(sm.state, ROOM_STATE.LOBBY);
  });

  it('rejects LOBBY → PLAYING (must go through COUNTDOWN)', () => {
    const sm = createStateMachine();
    assert.ok(!sm.transition(ROOM_STATE.PLAYING));
    assert.equal(sm.state, ROOM_STATE.LOBBY);
  });

  it('rejects LOBBY → RESULTS', () => {
    const sm = createStateMachine();
    assert.ok(!sm.transition(ROOM_STATE.RESULTS));
    assert.equal(sm.state, ROOM_STATE.LOBBY);
  });

  it('rejects PLAYING → COUNTDOWN (must go through RESULTS or LOBBY)', () => {
    const sm = createStateMachine(ROOM_STATE.PLAYING);
    assert.ok(!sm.transition(ROOM_STATE.COUNTDOWN));
    assert.equal(sm.state, ROOM_STATE.PLAYING);
  });

  it('allows any state → LOBBY (cancel/reset)', () => {
    for (const state of [ROOM_STATE.COUNTDOWN, ROOM_STATE.PLAYING, ROOM_STATE.RESULTS]) {
      const sm = createStateMachine(state);
      assert.ok(sm.transition(ROOM_STATE.LOBBY), `${state} → LOBBY should be allowed`);
    }
  });

  it('same-state transition returns true (no-op)', () => {
    const sm = createStateMachine(ROOM_STATE.PLAYING);
    assert.ok(sm.transition(ROOM_STATE.PLAYING));
    assert.equal(sm.state, ROOM_STATE.PLAYING);
  });

  it('full game lifecycle: LOBBY → COUNTDOWN → PLAYING → RESULTS → LOBBY', () => {
    const sm = createStateMachine();
    assert.ok(sm.transition(ROOM_STATE.COUNTDOWN));
    assert.ok(sm.transition(ROOM_STATE.PLAYING));
    assert.ok(sm.transition(ROOM_STATE.RESULTS));
    assert.ok(sm.transition(ROOM_STATE.LOBBY));
    assert.equal(sm.state, ROOM_STATE.LOBBY);
  });

  it('play again lifecycle: RESULTS → COUNTDOWN → PLAYING → RESULTS', () => {
    const sm = createStateMachine(ROOM_STATE.RESULTS);
    assert.ok(sm.transition(ROOM_STATE.COUNTDOWN));
    assert.ok(sm.transition(ROOM_STATE.PLAYING));
    assert.ok(sm.transition(ROOM_STATE.RESULTS));
  });
});

// =========================================================================
// nextAvailableSlot — player slot allocation
// =========================================================================

function nextAvailableSlot(players) {
  const used = [];
  for (const entry of players) {
    used.push(entry[1].playerIndex);
  }
  for (let i = 0; i < GameConstants.MAX_PLAYERS; i++) {
    if (used.indexOf(i) < 0) return i;
  }
  return -1;
}

describe('nextAvailableSlot', () => {
  it('returns 0 when no players', () => {
    assert.equal(nextAvailableSlot(new Map()), 0);
  });

  it('returns 1 when slot 0 is taken', () => {
    const players = new Map([['a', { playerIndex: 0 }]]);
    assert.equal(nextAvailableSlot(players), 1);
  });

  it('fills gaps when middle slot freed', () => {
    const players = new Map([
      ['a', { playerIndex: 0 }],
      ['c', { playerIndex: 2 }]
    ]);
    assert.equal(nextAvailableSlot(players), 1);
  });

  it('returns -1 when all slots full', () => {
    const players = new Map();
    for (let i = 0; i < GameConstants.MAX_PLAYERS; i++) {
      players.set('p' + i, { playerIndex: i });
    }
    assert.equal(nextAvailableSlot(players), -1);
  });

  it('returns lowest available slot', () => {
    const players = new Map([
      ['a', { playerIndex: 1 }],
      ['b', { playerIndex: 3 }]
    ]);
    assert.equal(nextAvailableSlot(players), 0);
  });
});

// =========================================================================
// sanitizePlayerName
// =========================================================================

describe('sanitizePlayerName', () => {
  it('returns HX fallback for empty name', () => {
    assert.equal(sanitizePlayerName(''), 'HX-1');
    assert.equal(sanitizePlayerName(null), 'HX-1');
  });

  it('skips blocked fallback numbers', () => {
    const players = new Map([
      ['a', { playerName: 'HX-1' }],
      ['b', { playerName: 'HX-2' }],
      ['c', { playerName: 'HX-3' }]
    ]);
    assert.equal(sanitizePlayerName('', players), 'HX-5');
  });

  it('treats default P1-P8 names as legacy fallbacks', () => {
    assert.equal(sanitizePlayerName('P1'), 'HX-1');
    assert.equal(sanitizePlayerName('P4'), 'HX-1');
    assert.equal(sanitizePlayerName('p3'), 'HX-1'); // case insensitive
  });

  it('preserves custom names', () => {
    assert.equal(sanitizePlayerName('Alice'), 'Alice');
    assert.equal(sanitizePlayerName('Bob'), 'Bob');
  });

  it('preserves names that look like P-names but are out of range', () => {
    assert.equal(sanitizePlayerName('P9'), 'P9');
    assert.equal(sanitizePlayerName('P0'), 'P0');
    assert.equal(sanitizePlayerName('P12'), 'P12');
  });

  it('reuses requested HX fallback when it is available', () => {
    const players = new Map([['a', { playerName: 'HX-7' }]]);
    assert.equal(sanitizePlayerName('HX-8', players, 'b', true), 'HX-8');
  });

  it('reassigns requested HX fallback when it is already taken', () => {
    const players = new Map([['a', { playerName: 'HX-8' }]]);
    assert.equal(sanitizePlayerName('HX-8', players, 'b', true), 'HX-1');
  });
});

// =========================================================================
// getHostPeerIndex — AirConsole master-controller rule (lowest playerIndex)
// =========================================================================

// Mirrors DisplayState.js getHostPeerIndex / electNextHost — keep in sync.
//
// Sticky host: `hostPeerIndex` is a stored slot (not a computed min).
// It is:
//   - Initialized by the first joiner (onPeerJoined / onHello).
//   - Reassigned by electNextHost() when the holder leaves (onPeerLeft),
//     which picks the oldest-joined remaining present player.
//   - Preserved across color changes and temporary disconnects.
// getHostPeerIndex returns the stored host when available; otherwise it
// returns a read-only fallback (oldest-joined present eligible player)
// so mid-game disconnect transparently defers host duty until the
// reassignment happens in the next onPeerLeft.
function getHostPeerIndex(players, party, roomState, playerOrder, disconnectedQRs, hostPeerIndex) {
  const restricted = (roomState === ROOM_STATE.PLAYING
                   || roomState === ROOM_STATE.COUNTDOWN
                   || roomState === ROOM_STATE.RESULTS)
                  && playerOrder && playerOrder.length > 0;
  const eligible = restricted ? new Set(playerOrder) : null;
  const disconnected = disconnectedQRs || new Map();

  if (party && typeof party.getMasterPeerIndex === 'function') {
    const acHost = party.getMasterPeerIndex();
    if (acHost != null && players.has(acHost) && !disconnected.has(acHost)
        && (!restricted || eligible.has(acHost))) {
      return acHost;
    }
  }

  if (hostPeerIndex != null && players.has(hostPeerIndex)
      && !disconnected.has(hostPeerIndex)
      && (!restricted || eligible.has(hostPeerIndex))) {
    return hostPeerIndex;
  }

  let fallbackId = null;
  let fallbackJoin = Infinity;
  for (const entry of players) {
    if (disconnected.has(entry[0])) continue;
    if (restricted && !eligible.has(entry[0])) continue;
    const ja = entry[1].joinedAt == null ? Infinity : entry[1].joinedAt;
    if (ja < fallbackJoin) {
      fallbackJoin = ja;
      fallbackId = entry[0];
    }
  }
  return fallbackId;
}

function electNextHost(players, disconnectedQRs, excludeId) {
  const disconnected = disconnectedQRs || new Map();
  let nextId = null;
  let nextJoin = Infinity;
  for (const entry of players) {
    if (entry[0] === excludeId) continue;
    if (disconnected.has(entry[0])) continue;
    const ja = entry[1].joinedAt == null ? Infinity : entry[1].joinedAt;
    if (ja < nextJoin) {
      nextJoin = ja;
      nextId = entry[0];
    }
  }
  return nextId;
}

// Small helper for tests — create an entry with a monotonic joinedAt so
// tests don't have to hand-pick timestamps. Each call gets a larger value.
let _testJoinCounter = 0;
function seed(playerIndex) {
  return { playerIndex, joinedAt: ++_testJoinCounter };
}

describe('getHostPeerIndex (sticky host)', () => {
  it('returns null for empty lobby', () => {
    assert.equal(getHostPeerIndex(new Map()), null);
  });

  it('returns the stored host when present and connected', () => {
    const players = new Map([['a', seed(0)]]);
    assert.equal(getHostPeerIndex(players, null, undefined, undefined, undefined, 'a'), 'a');
  });

  it('stored host wins even when another player has a lower palette slot', () => {
    // Alice was first (host). Bob joined later. Alice picks a higher color —
    // Bob is now at slot 0 but Alice stays host (sticky).
    const players = new Map([
      ['alice', { playerIndex: 3, joinedAt: 1 }],
      ['bob',   { playerIndex: 0, joinedAt: 2 }]
    ]);
    assert.equal(getHostPeerIndex(players, null, undefined, undefined, undefined, 'alice'), 'alice');
  });

  it('host survives a color change (playerIndex no longer affects host)', () => {
    // Alice joined first with palette slot 0. She changes to slot 5.
    // hostPeerIndex points to 'alice' throughout — no re-election needed.
    const players = new Map([
      ['alice', { playerIndex: 0, joinedAt: 1 }],
      ['bob',   { playerIndex: 1, joinedAt: 2 }]
    ]);
    assert.equal(getHostPeerIndex(players, null, undefined, undefined, undefined, 'alice'), 'alice');
    // Color change — just mutate playerIndex.
    players.get('alice').playerIndex = 5;
    assert.equal(getHostPeerIndex(players, null, undefined, undefined, undefined, 'alice'), 'alice');
  });

  it('electNextHost picks oldest-joined remaining player', () => {
    const players = new Map([
      ['alice', { playerIndex: 0, joinedAt: 1 }],
      ['bob',   { playerIndex: 1, joinedAt: 2 }],
      ['carol', { playerIndex: 2, joinedAt: 3 }]
    ]);
    // Alice (host) is about to leave — next host should be Bob (older than Carol).
    assert.equal(electNextHost(players, null, 'alice'), 'bob');
  });

  it('handoff flow: onPeerLeft reassigns then getHostPeerIndex returns new host', () => {
    // Simulates what DisplayConnection does: electNextHost → delete player.
    const players = new Map([
      ['alice', { playerIndex: 0, joinedAt: 1 }],
      ['bob',   { playerIndex: 1, joinedAt: 2 }]
    ]);
    let hostId = 'alice';
    assert.equal(getHostPeerIndex(players, null, undefined, undefined, undefined, hostId), 'alice');
    // Alice leaves — onPeerLeft runs electNextHost BEFORE removing her.
    hostId = electNextHost(players, null, 'alice');
    players.delete('alice');
    assert.equal(hostId, 'bob');
    assert.equal(getHostPeerIndex(players, null, undefined, undefined, undefined, hostId), 'bob');
  });

  it('sticky: a returning original host does NOT reclaim', () => {
    // Alice (host) leaves. onPeerLeft reassigns host to Bob.
    // Later Alice rejoins — she's a new entry with a new joinedAt and
    // hostPeerIndex still points to Bob.
    const players = new Map([
      ['alice', { playerIndex: 0, joinedAt: 1 }],
      ['bob',   { playerIndex: 1, joinedAt: 2 }]
    ]);
    let hostId = electNextHost(players, null, 'alice');
    assert.equal(hostId, 'bob');
    players.delete('alice');
    // ...time passes...
    players.set('alice', { playerIndex: 0, joinedAt: 99 });  // returns
    // hostPeerIndex is not touched on a normal join (only on null-init or leave).
    assert.equal(getHostPeerIndex(players, null, undefined, undefined, undefined, hostId), 'bob');
  });

  it('AirConsole path: adapter-reported master wins over stored sticky host', () => {
    // A premium device is promoted by the AirConsole platform mid-session.
    // This overrides our sticky slot — AC owns host on that platform.
    const players = new Map([
      ['a', seed(0)],
      ['b', seed(1)],
      ['c', seed(2)]
    ]);
    const party = { getMasterPeerIndex: () => 'c' };
    assert.equal(getHostPeerIndex(players, party, undefined, undefined, undefined, 'a'), 'c');
  });

  it('AirConsole path: falls through to sticky when master has not sent HELLO yet', () => {
    const players = new Map([['a', seed(0)], ['b', seed(1)]]);
    const party = { getMasterPeerIndex: () => '9' };
    assert.equal(getHostPeerIndex(players, party, undefined, undefined, undefined, 'a'), 'a');
  });

  it('AirConsole path: null master falls through to sticky', () => {
    const players = new Map([['a', seed(0)]]);
    const party = { getMasterPeerIndex: () => null };
    assert.equal(getHostPeerIndex(players, party, undefined, undefined, undefined, 'a'), 'a');
  });

  it('RESULTS: late joiner cannot steal Play Again from sticky host', () => {
    // During RESULTS the restriction prevents a late joiner (not in
    // playerOrder) from getting host duty — bob stays host even though
    // 'late' joined afterwards with a lower palette slot.
    const players = new Map([
      ['bob',  { playerIndex: 1, joinedAt: 1 }],
      ['late', { playerIndex: 0, joinedAt: 2 }]
    ]);
    const playerOrder = ['bob'];
    assert.equal(
      getHostPeerIndex(players, null, ROOM_STATE.RESULTS, playerOrder, null, 'bob'),
      'bob'
    );
  });

  it('PLAYING: sticky host that is a late joiner is ineligible; oldest active takes over', () => {
    // Sticky host = 'late' (late joiner). During active game, only players
    // in playerOrder can act as host — so the fallback elects the oldest
    // in-order player (alice). hostPeerIndex is NOT mutated here (read-only
    // fallback); the sticky slot will resume control in LOBBY.
    const players = new Map([
      ['alice', { playerIndex: 1, joinedAt: 1 }],
      ['bob',   { playerIndex: 2, joinedAt: 2 }],
      ['late',  { playerIndex: 0, joinedAt: 3 }]
    ]);
    const playerOrder = ['alice', 'bob'];
    assert.equal(
      getHostPeerIndex(players, null, ROOM_STATE.PLAYING, playerOrder, null, 'late'),
      'alice'
    );
  });

  it('PLAYING: AC master that is not in playerOrder is ignored', () => {
    const players = new Map([
      ['carol', seed(2)],
      ['alice', seed(0)],
      ['bob',   seed(1)]
    ]);
    const playerOrder = ['alice', 'bob'];
    const party = { getMasterPeerIndex: () => 'carol' };
    assert.equal(
      getHostPeerIndex(players, party, ROOM_STATE.PLAYING, playerOrder, null, 'alice'),
      'alice'
    );
  });

  it('fallback when playerOrder is unexpectedly empty during RESULTS', () => {
    // Defensive: restriction is dropped when playerOrder is empty.
    const players = new Map([['a', seed(0)]]);
    assert.equal(getHostPeerIndex(players, null, ROOM_STATE.RESULTS, [], null, 'a'), 'a');
  });

  it('PLAYING: disconnected sticky host → read-only fallback to next-oldest', () => {
    // Alice is sticky host but currently disconnected. During the blip the
    // fallback returns bob (oldest other active), without mutating hostPeerIndex.
    // (In production, onPeerLeft has already been invoked and hostPeerIndex was
    // transferred to bob — this test covers the brief window BEFORE that runs,
    // or any race where getHostPeerIndex is called with stale hostPeerIndex.)
    const players = new Map([
      ['alice', { playerIndex: 0, joinedAt: 1 }],
      ['bob',   { playerIndex: 1, joinedAt: 2 }],
      ['carol', { playerIndex: 2, joinedAt: 3 }]
    ]);
    const playerOrder = ['alice', 'bob', 'carol'];
    const disconnectedQRs = new Map([['alice', null]]);
    assert.equal(
      getHostPeerIndex(players, null, ROOM_STATE.PLAYING, playerOrder, disconnectedQRs, 'alice'),
      'bob'
    );
  });

  it('AirConsole path: disconnected AC master falls through to sticky host', () => {
    const players = new Map([
      ['alice', { playerIndex: 0, joinedAt: 1 }],
      ['bob',   { playerIndex: 1, joinedAt: 2 }]
    ]);
    const playerOrder = ['alice', 'bob'];
    const party = { getMasterPeerIndex: () => 'alice' };
    const disconnectedQRs = new Map([['alice', null]]);
    // AC master 'alice' is disconnected → skip. Sticky host 'alice' is also
    // disconnected → fallback to oldest connected = 'bob'.
    assert.equal(
      getHostPeerIndex(players, party, ROOM_STATE.PLAYING, playerOrder, disconnectedQRs, 'alice'),
      'bob'
    );
  });

  it('returns null when every eligible candidate is disconnected', () => {
    const players = new Map([
      ['alice', seed(0)],
      ['bob',   seed(1)]
    ]);
    const playerOrder = ['alice', 'bob'];
    const disconnectedQRs = new Map([['alice', null], ['bob', null]]);
    assert.equal(
      getHostPeerIndex(players, null, ROOM_STATE.PLAYING, playerOrder, disconnectedQRs, 'alice'),
      null
    );
  });

  it('electNextHost returns null when nobody else qualifies', () => {
    const players = new Map([['alice', { playerIndex: 0, joinedAt: 1 }]]);
    assert.equal(electNextHost(players, null, 'alice'), null);
  });

  it('electNextHost skips disconnected candidates', () => {
    const players = new Map([
      ['alice', { playerIndex: 0, joinedAt: 1 }],
      ['bob',   { playerIndex: 1, joinedAt: 2 }],
      ['carol', { playerIndex: 2, joinedAt: 3 }]
    ]);
    const disconnectedQRs = new Map([['bob', null]]);
    // Alice leaves; Bob is next-oldest but disconnected; Carol wins.
    assert.equal(electNextHost(players, disconnectedQRs, 'alice'), 'carol');
  });
});

// =========================================================================
// Input validation (from DisplayInput.js)
// =========================================================================

const VALID_ACTIONS = new Set(Object.values(INPUT));

describe('Input validation', () => {
  it('accepts all defined INPUT actions', () => {
    for (const action of Object.values(INPUT)) {
      assert.ok(VALID_ACTIONS.has(action), `${action} should be valid`);
    }
  });

  it('rejects unknown actions', () => {
    assert.ok(!VALID_ACTIONS.has('teleport'));
    assert.ok(!VALID_ACTIONS.has(''));
    assert.ok(!VALID_ACTIONS.has(null));
    assert.ok(!VALID_ACTIONS.has(undefined));
  });

  it('rejects actions with wrong case', () => {
    assert.ok(!VALID_ACTIONS.has('LEFT'));
    assert.ok(!VALID_ACTIONS.has('Hard_Drop'));
  });
});

// =========================================================================
// Level validation (from DisplayInput.js onSetLevel)
// =========================================================================

describe('Level validation', () => {
  function isValidLevel(level) {
    const parsed = parseInt(level, 10);
    return !isNaN(parsed) && parsed >= 1 && parsed <= 15;
  }

  it('accepts levels 1-15', () => {
    for (let i = 1; i <= 15; i++) {
      assert.ok(isValidLevel(i), `level ${i} should be valid`);
    }
  });

  it('accepts string levels', () => {
    assert.ok(isValidLevel('5'));
    assert.ok(isValidLevel('15'));
  });

  it('rejects level 0', () => {
    assert.ok(!isValidLevel(0));
  });

  it('rejects level 16+', () => {
    assert.ok(!isValidLevel(16));
    assert.ok(!isValidLevel(99));
  });

  it('rejects NaN', () => {
    assert.ok(!isValidLevel('abc'));
    assert.ok(!isValidLevel(NaN));
  });
});
