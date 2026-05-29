'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { sanitizePlayerName } = require('./auto-name-helper');

// Load protocol for ROOM_STATE
const { ROOM_STATE, MSG, INPUT } = require('../public/shared/protocol');

// Simulate the minimal globals that DisplayState.js functions depend on
const GameConstants = require('../server/constants');

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
