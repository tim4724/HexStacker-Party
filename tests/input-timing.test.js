'use strict';

// Engine input-timing rules that moved out of the display glue (DisplayInput.js)
// into the deterministic, clock-free engine:
//   1. soft-drop auto-end (PlayerBoard.softDropDeadlineMs)
//   2. hard-drop supersedes soft-drop (PlayerBoard.hardDrop)
//   3. hard-drop rate limit (Game._hardDropCooldownMs, input layer)
// All driven by accumulated deltaMs — no wall clock.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { PlayerBoard } = require('../server/PlayerBoard');
const { Game } = require('../server/Game');
const {
  SOFT_DROP_TIMEOUT_MS,
  HARD_DROP_MIN_INTERVAL_MS,
  SOFT_DROP_MULTIPLIER,
} = require('../server/constants');

function makeGame(playerCount, seed) {
  const players = new Map();
  for (let i = 0; i < playerCount; i++) players.set('p' + i, { startLevel: 1 });
  const events = [];
  const game = new Game(players, {
    onEvent: (e) => events.push(e),
    onGameEnd: () => {},
  }, seed || 42);
  game.init();
  return { game, events };
}

const countLocks = (events, id) =>
  events.filter((e) => e.type === 'piece_lock' && e.playerId === id).length;

describe('Soft-drop auto-end (PlayerBoard.softDropDeadlineMs)', () => {
  it('arms the deadline on softDropStart', () => {
    const b = new PlayerBoard('p', 42, 1);
    b.spawnPiece();
    assert.equal(b.softDropDeadlineMs, 0);
    b.softDropStart(SOFT_DROP_MULTIPLIER);
    assert.equal(b.softDropping, true);
    assert.equal(b.softDropDeadlineMs, SOFT_DROP_TIMEOUT_MS);
  });

  it('auto-ends after SOFT_DROP_TIMEOUT_MS of accumulated deltaMs with no further message', () => {
    // The lost-SOFT_DROP_END recovery case: the explicit end never arrives,
    // so the board must stop accelerating on its own.
    const b = new PlayerBoard('p', 42, 1);
    b.spawnPiece();
    b.softDropStart(SOFT_DROP_MULTIPLIER);

    b.tick(SOFT_DROP_TIMEOUT_MS - 50);
    assert.equal(b.softDropping, true, 'still soft-dropping before the deadline');

    b.tick(100); // crosses the deadline
    assert.equal(b.softDropping, false, 'auto-ended after the timeout');
    assert.equal(b.softDropSpeed, SOFT_DROP_MULTIPLIER, 'speed reset on auto-end');
  });

  it('counts down regardless of piece/clearing state (decrement sits above the piece guards)', () => {
    const b = new PlayerBoard('p', 42, 1);
    b.spawnPiece();
    b.currentPiece = null; // tick() early-returns below the deadline decrement
    b.softDropStart(SOFT_DROP_MULTIPLIER);

    b.tick(100);
    assert.equal(b.softDropDeadlineMs, SOFT_DROP_TIMEOUT_MS - 100);
    assert.equal(b.softDropping, true);

    b.tick(SOFT_DROP_TIMEOUT_MS);
    assert.equal(b.softDropping, false, 'expired even with no current piece');
  });

  it('re-arms on a second softDropStart, extending the soft drop past the original 300ms', () => {
    const b = new PlayerBoard('p', 42, 1);
    b.spawnPiece();
    b.softDropStart(SOFT_DROP_MULTIPLIER); // deadline 300
    b.tick(200);                            // deadline 100
    assert.equal(b.softDropping, true);

    b.softDropStart(SOFT_DROP_MULTIPLIER);  // re-arm -> deadline 300
    b.tick(200);                            // deadline 100 (would be -100 without the re-arm)
    assert.equal(b.softDropping, true, 'survives past the original 300ms window when re-armed');

    b.tick(200);                            // deadline -100 -> end
    assert.equal(b.softDropping, false);
  });

  it('does NOT reset gravityCounter on a softDropStart while already soft-dropping', () => {
    const b = new PlayerBoard('p', 42, 1);
    b.spawnPiece();
    b.softDropStart(SOFT_DROP_MULTIPLIER); // fresh start resets gravityCounter
    b.gravityCounter = 7;                   // simulate accumulated gravity

    b.softDropStart(SOFT_DROP_MULTIPLIER); // already soft-dropping -> no reset
    assert.equal(b.gravityCounter, 7);

    b.softDropEnd();
    b.softDropStart(SOFT_DROP_MULTIPLIER); // fresh start -> reset
    assert.equal(b.gravityCounter, 0);
  });

  it('auto-ends when driven through Game.update(deltaMs), not just board.tick', () => {
    // The production path is Game.update -> board.tick; assert the deadline
    // advances and expires there, not only on a direct board.tick().
    const { game } = makeGame(1);
    const b = game.boards.get('p0');
    game.handleSoftDropStart('p0', SOFT_DROP_MULTIPLIER);
    assert.equal(b.softDropping, true);

    game.update(SOFT_DROP_TIMEOUT_MS - 50);
    assert.equal(b.softDropping, true, 'still soft-dropping before the deadline');
    game.update(100); // crosses the deadline
    assert.equal(b.softDropping, false, 'auto-ended via the Game.update path');
  });

  it('freezes the soft-drop deadline while paused (Game.update early-returns)', () => {
    // Symmetry with the hard-drop cooldown freeze: a paused Game.update must not
    // advance the deadline, so a held soft-drop survives a pause/resume.
    const { game } = makeGame(1);
    const b = game.boards.get('p0');
    game.handleSoftDropStart('p0', SOFT_DROP_MULTIPLIER);
    assert.equal(b.softDropDeadlineMs, SOFT_DROP_TIMEOUT_MS);

    game.pause();
    game.update(SOFT_DROP_TIMEOUT_MS * 2); // would expire if it ticked
    game.resume();
    assert.equal(b.softDropping, true, 'still soft-dropping — deadline frozen while paused');
    assert.equal(b.softDropDeadlineMs, SOFT_DROP_TIMEOUT_MS, 'deadline did not advance while paused');
  });
});

describe('Hard-drop supersedes soft-drop (PlayerBoard.hardDrop)', () => {
  it('clears softDropping when called directly on the board', () => {
    const b = new PlayerBoard('p', 42, 1);
    b.spawnPiece();
    b.softDropStart(SOFT_DROP_MULTIPLIER);
    assert.equal(b.softDropping, true);

    b.hardDrop();
    assert.equal(b.softDropping, false, 'hard drop ended the soft drop');
    assert.equal(b.softDropSpeed, SOFT_DROP_MULTIPLIER);
  });

  it('clears softDropping through Game.processInput hard_drop', () => {
    const { game } = makeGame(1);
    const b = game.boards.get('p0');
    game.handleSoftDropStart('p0', SOFT_DROP_MULTIPLIER);
    assert.equal(b.softDropping, true);

    game.processInput('p0', 'hard_drop');
    assert.equal(b.softDropping, false);
  });
});

describe('Hard-drop rate limit (Game._hardDropCooldownMs, input layer)', () => {
  it('throttles a second hard_drop issued before the cooldown elapses (no second lock)', () => {
    const { game, events } = makeGame(1);

    game.processInput('p0', 'hard_drop');
    assert.equal(countLocks(events, 'p0'), 1, 'first drop locked');

    game.processInput('p0', 'hard_drop'); // immediate repeat, no update() between
    assert.equal(countLocks(events, 'p0'), 1, 'second drop throttled silently');
    assert.equal(events.some((e) => e.type === 'hard_drop_throttled'), false,
      'throttle is silent (emits no new event)');
  });

  it('allows the next hard_drop once enough update(deltaMs) has elapsed', () => {
    const { game, events } = makeGame(1);

    game.processInput('p0', 'hard_drop');           // lock 1, cooldown = 150
    game.processInput('p0', 'hard_drop');           // throttled
    assert.equal(countLocks(events, 'p0'), 1);

    game.update(HARD_DROP_MIN_INTERVAL_MS);          // cooldown -> 0
    game.processInput('p0', 'hard_drop');            // allowed -> lock 2
    assert.equal(countLocks(events, 'p0'), 2, 'drop allowed after the cooldown elapsed');
  });

  it('is per-player: throttling p0 does not throttle p1', () => {
    const { game, events } = makeGame(2);

    game.processInput('p0', 'hard_drop');   // p0 lock 1, p0 cooldown set
    game.processInput('p0', 'hard_drop');   // p0 throttled
    game.processInput('p1', 'hard_drop');   // p1 has its own cooldown -> allowed

    assert.equal(countLocks(events, 'p0'), 1);
    assert.equal(countLocks(events, 'p1'), 1, 'p1 drop not blocked by p0 cooldown');
  });

  it('freezes the cooldown while paused (update early-returns)', () => {
    const { game, events } = makeGame(1);

    game.processInput('p0', 'hard_drop');   // cooldown = 150
    game.pause();
    game.update(HARD_DROP_MIN_INTERVAL_MS); // no-op while paused
    game.resume();
    game.processInput('p0', 'hard_drop');   // still within cooldown -> throttled
    assert.equal(countLocks(events, 'p0'), 1, 'cooldown did not tick down while paused');
  });
});

describe('board.hardDrop() stays an ungated primitive', () => {
  it('locks consecutive drops with no tick() between (no board-level cooldown)', () => {
    const b = new PlayerBoard('p', 42, 1);
    b.spawnPiece();

    const r1 = b.hardDrop();
    const r2 = b.hardDrop(); // immediate, no tick / no time elapsed
    assert.ok(r1 && r2, 'both back-to-back hard drops locked — primitive is ungated');

    // And in a tight loop, every call while alive locks a piece (gameplay-integration semantics).
    let locks = 0;
    for (let i = 0; i < 15 && b.alive; i++) {
      if (b.hardDrop()) locks++;
    }
    assert.ok(locks >= 1, 'loop keeps locking until the board tops out');
  });
});
