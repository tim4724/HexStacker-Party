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
// Game mode validation
// =========================================================================

describe('Game mode validation', () => {
  function isValidMode(mode) {
    return mode === 'classic' || mode === 'hex';
  }

  it('accepts classic', () => {
    assert.ok(isValidMode('classic'));
  });

  it('accepts hex', () => {
    assert.ok(isValidMode('hex'));
  });

  it('rejects unknown modes', () => {
    assert.ok(!isValidMode('triangle'));
    assert.ok(!isValidMode(''));
    assert.ok(!isValidMode(null));
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
