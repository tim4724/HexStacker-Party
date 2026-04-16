'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

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

function sanitizePlayerName(name, slotIndex) {
  if (!name || /^P[1-8]$/i.test(name)) return 'P' + (slotIndex + 1);
  return name;
}

describe('sanitizePlayerName', () => {
  it('returns slot label for empty name', () => {
    assert.equal(sanitizePlayerName('', 0), 'P1');
    assert.equal(sanitizePlayerName('', 2), 'P3');
  });

  it('returns slot label for null/undefined', () => {
    assert.equal(sanitizePlayerName(null, 0), 'P1');
    assert.equal(sanitizePlayerName(undefined, 1), 'P2');
  });

  it('returns slot label for default P1-P8 names', () => {
    assert.equal(sanitizePlayerName('P1', 2), 'P3');
    assert.equal(sanitizePlayerName('P4', 0), 'P1');
    assert.equal(sanitizePlayerName('p3', 1), 'P2'); // case insensitive
  });

  it('preserves custom names', () => {
    assert.equal(sanitizePlayerName('Alice', 0), 'Alice');
    assert.equal(sanitizePlayerName('Bob', 3), 'Bob');
  });

  it('preserves names that look like P-names but are out of range', () => {
    assert.equal(sanitizePlayerName('P9', 0), 'P9');
    assert.equal(sanitizePlayerName('P0', 0), 'P0');
    assert.equal(sanitizePlayerName('P12', 0), 'P12');
  });
});

// =========================================================================
// getHostClientId — AirConsole master-controller rule (lowest playerIndex)
// =========================================================================

// Mirrors DisplayState.js getHostClientId — keep in sync.
function getHostClientId(players, party, roomState, playerOrder) {
  const restricted = (roomState === ROOM_STATE.PLAYING
                   || roomState === ROOM_STATE.COUNTDOWN
                   || roomState === ROOM_STATE.RESULTS)
                  && playerOrder && playerOrder.length > 0;
  const eligible = restricted ? new Set(playerOrder) : null;

  if (party && typeof party.getMasterClientId === 'function') {
    const acHost = party.getMasterClientId();
    if (acHost && players.has(acHost) && (!restricted || eligible.has(acHost))) {
      return acHost;
    }
  }
  let hostId = null;
  let hostIdx = Infinity;
  for (const entry of players) {
    if (restricted && !eligible.has(entry[0])) continue;
    if (entry[1].playerIndex < hostIdx) {
      hostIdx = entry[1].playerIndex;
      hostId = entry[0];
    }
  }
  return hostId;
}

describe('getHostClientId', () => {
  it('returns null for empty lobby', () => {
    assert.equal(getHostClientId(new Map()), null);
  });

  it('returns the only player', () => {
    const players = new Map([['a', { playerIndex: 0 }]]);
    assert.equal(getHostClientId(players), 'a');
  });

  it('returns lowest-index player regardless of insertion order', () => {
    const players = new Map([
      ['b', { playerIndex: 2 }],
      ['a', { playerIndex: 0 }],
      ['c', { playerIndex: 1 }]
    ]);
    assert.equal(getHostClientId(players), 'a');
  });

  it('handoff: next-lowest becomes host when current host leaves', () => {
    const players = new Map([
      ['a', { playerIndex: 0 }],
      ['b', { playerIndex: 1 }],
      ['c', { playerIndex: 2 }]
    ]);
    assert.equal(getHostClientId(players), 'a');
    players.delete('a');
    assert.equal(getHostClientId(players), 'b');
  });

  it('reclaim: a new low-slot joiner becomes host', () => {
    // Slots 1 and 2 are filled; slot 0 opens up and a new player takes it.
    const players = new Map([
      ['b', { playerIndex: 1 }],
      ['c', { playerIndex: 2 }]
    ]);
    assert.equal(getHostClientId(players), 'b');
    players.set('newcomer', { playerIndex: 0 });
    assert.equal(getHostClientId(players), 'newcomer');
  });

  it('AirConsole path: adapter-reported master wins over lowest slot', () => {
    // A premium device in slot 2 would still be master — AC prioritizes premium.
    const players = new Map([
      ['a', { playerIndex: 0 }],
      ['b', { playerIndex: 1 }],
      ['c', { playerIndex: 2 }]
    ]);
    const party = { getMasterClientId: () => 'c' };
    assert.equal(getHostClientId(players, party), 'c');
  });

  it('AirConsole path: falls back when master has not sent HELLO yet', () => {
    // AC reports device 9 as master but we haven't received HELLO from them.
    // Until players.has(9), use lowest-slot among known players.
    const players = new Map([
      ['a', { playerIndex: 0 }],
      ['b', { playerIndex: 1 }]
    ]);
    const party = { getMasterClientId: () => '9' };
    assert.equal(getHostClientId(players, party), 'a');
  });

  it('AirConsole path: null master falls through to slot rule', () => {
    const players = new Map([['a', { playerIndex: 0 }]]);
    const party = { getMasterClientId: () => null };
    assert.equal(getHostClientId(players, party), 'a');
  });

  it('PLAYING: excludes late joiners not in playerOrder', () => {
    // Alice and Bob are playing; Carol joined mid-game as slot 2 (not in
    // playerOrder). Without the restriction the lowest-slot rule would
    // pick Alice anyway, so set up Carol in slot 0 to prove the restriction
    // is what's actually doing the work (simulates slot reclaim path).
    const players = new Map([
      ['carol', { playerIndex: 0 }],  // late joiner, not in playerOrder
      ['alice', { playerIndex: 1 }],
      ['bob',   { playerIndex: 2 }]
    ]);
    const playerOrder = ['alice', 'bob'];
    assert.equal(getHostClientId(players, null, ROOM_STATE.PLAYING, playerOrder), 'alice');
  });

  it('PLAYING: AC master that is not in playerOrder is ignored', () => {
    // AC promoted Carol (late joiner) to master, but she can't reach the
    // pause overlay — host stays with an active participant to avoid
    // deadlocking RETURN_TO_LOBBY.
    const players = new Map([
      ['carol', { playerIndex: 2 }],
      ['alice', { playerIndex: 0 }],
      ['bob',   { playerIndex: 1 }]
    ]);
    const playerOrder = ['alice', 'bob'];
    const party = { getMasterClientId: () => 'carol' };
    assert.equal(getHostClientId(players, party, ROOM_STATE.PLAYING, playerOrder), 'alice');
  });

  it('RESULTS: restriction also applies so late joiner cannot steal Play Again', () => {
    const players = new Map([
      ['carol', { playerIndex: 0 }],  // joined during RESULTS
      ['bob',   { playerIndex: 1 }]   // original player, inherited host
    ]);
    const playerOrder = ['bob'];
    assert.equal(getHostClientId(players, null, ROOM_STATE.RESULTS, playerOrder), 'bob');
  });

  it('LOBBY: restriction lifted — late joiner reclaiming slot 0 can be host', () => {
    // After returnToLobby, all players are in playerOrder again, so the
    // restriction is moot. But even a hypothetical player not in playerOrder
    // should be eligible here (LOBBY is "everyone on equal footing").
    const players = new Map([
      ['newcomer', { playerIndex: 0 }],
      ['existing', { playerIndex: 1 }]
    ]);
    assert.equal(getHostClientId(players, null, ROOM_STATE.LOBBY, []), 'newcomer');
  });

  it('fallback when playerOrder is unexpectedly empty during RESULTS', () => {
    // Defensive: if playerOrder is empty during RESULTS (shouldn't happen),
    // fall back to the full candidate set rather than returning null.
    const players = new Map([['a', { playerIndex: 0 }]]);
    assert.equal(getHostClientId(players, null, ROOM_STATE.RESULTS, []), 'a');
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
