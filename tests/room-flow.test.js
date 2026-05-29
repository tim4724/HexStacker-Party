'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const RoomFlow = require('../partyplug/RoomFlow');
const S = RoomFlow.STATES;

// Controllable clock so countdown timing is deterministic. flush() runs every
// scheduled task (and any it reschedules) to completion.
function makeClock() {
  let id = 0;
  const tasks = new Map();
  return {
    timers: {
      setTimeout(fn) { const t = ++id; tasks.set(t, fn); return t; },
      clearTimeout(t) { tasks.delete(t); },
    },
    pending() { return tasks.size; },
    flush() {
      let guard = 0;
      while (tasks.size) {
        if (++guard > 1000) throw new Error('clock flush runaway');
        const [t, fn] = tasks.entries().next().value;
        tasks.delete(t);
        fn();
      }
    },
  };
}

// Record every emitted event as [type, detail].
function record(flow) {
  const log = [];
  flow.on('*', (type, detail) => log.push([type, detail]));
  return log;
}

describe('RoomFlow — roster + slots', () => {
  it('starts empty in lobby', () => {
    const f = new RoomFlow();
    assert.equal(f.state, S.LOBBY);
    assert.equal(f.size, 0);
    assert.equal(f.host, null);
  });

  it('assigns sequential color slots and makes the first joiner host', () => {
    const f = new RoomFlow();
    const a = f.addPlayer(10, { name: 'A' });
    const b = f.addPlayer(11, { name: 'B' });
    const c = f.addPlayer(12, { name: 'C' });
    assert.deepEqual([a.colorIndex, b.colorIndex, c.colorIndex], [0, 1, 2]);
    assert.equal(f.host, 10);
    assert.equal(f.connectedCount, 3);
  });

  it('honors a requested free color slot, falls back when taken', () => {
    const f = new RoomFlow();
    f.addPlayer(1, { colorIndex: 3 });
    assert.equal(f.get(1).colorIndex, 3);
    const second = f.addPlayer(2, { colorIndex: 3 }); // taken -> first free (0)
    assert.equal(second.colorIndex, 0);
  });

  it('reconnecting the same peerIndex keeps slot/join order/host', () => {
    const f = new RoomFlow();
    f.addPlayer(1, { name: 'A' });
    f.addPlayer(2, { name: 'B' });
    const before = f.get(1).joinedAt;
    f.markDisconnected(1);
    assert.equal(f.isDisconnected(1), true);
    const again = f.addPlayer(1, { name: 'A2' });
    assert.equal(again.joinedAt, before);
    assert.equal(again.colorIndex, 0);
    assert.equal(again.name, 'A2');
    assert.equal(f.isDisconnected(1), false);
    assert.equal(f.host, 1); // host slot retained
  });
});

describe('RoomFlow — color validation', () => {
  it('rejects out-of-range and collisions, accepts free, no-ops same', () => {
    const f = new RoomFlow({ maxPlayers: 4 });
    f.addPlayer(1); // slot 0
    f.addPlayer(2); // slot 1
    assert.equal(f.setColor(1, 9), false);    // out of range
    assert.equal(f.setColor(1, -1), false);   // out of range
    assert.equal(f.setColor(1, 1), false);    // taken by peer 2
    assert.equal(f.setColor(1, 0), true);     // no-op (already 0)
    assert.equal(f.setColor(1, 2), true);     // free
    assert.equal(f.get(1).colorIndex, 2);
  });
});

describe('RoomFlow — host election', () => {
  it('elects next oldest when host leaves in lobby', () => {
    const f = new RoomFlow();
    f.addPlayer(1); f.addPlayer(2); f.addPlayer(3);
    assert.equal(f.host, 1);
    f.removePlayer(1);
    assert.equal(f.host, 2);
    assert.equal(f.hostPeerIndex, 2); // sticky slot committed
  });

  it('keeps the sticky slot when host leaves mid-game; getter falls back', () => {
    const f = new RoomFlow();
    f.addPlayer(1); f.addPlayer(2);
    f.requestStart();              // snapshot order [1,2], -> countdown
    f._transition(S.PLAYING);      // (skip countdown wait for this assertion)
    f.removePlayer(1);             // host leaves mid-game
    assert.equal(f.hostPeerIndex, 1);  // slot untouched
    assert.equal(f.host, 2);           // effective host falls back to participant
  });

  it('a late joiner cannot become host mid-game (restricted to participants)', () => {
    const f = new RoomFlow();
    f.addPlayer(1); f.addPlayer(2);
    f.requestStart();
    f._transition(S.PLAYING);          // order = [1,2]
    f.addPlayer(3);                    // late joiner, not in order
    f.markDisconnected(1);
    f.markDisconnected(2);
    // both participants gone -> nobody eligible (late joiner excluded)
    assert.equal(f.host, null);
  });

  it('uses masterProvider when eligible, ignores it when not', () => {
    let master = 2;
    const f = new RoomFlow({ masterProvider: () => master });
    f.addPlayer(1); f.addPlayer(2);
    assert.equal(f.host, 2);           // master overrides sticky in lobby
    master = 999;                      // master not a known player
    assert.equal(f.host, 1);           // falls back to sticky
  });

  it('disconnected host falls back, restored on reconnect', () => {
    const f = new RoomFlow();
    f.addPlayer(1); f.addPlayer(2);
    f.markDisconnected(1);
    assert.equal(f.host, 2);
    f.markReconnected(1);
    assert.equal(f.host, 1);
  });

  it('reconcile on entering results commits a handoff when host is gone', () => {
    const f = new RoomFlow();
    f.addPlayer(1); f.addPlayer(2);
    f.requestStart(); f._transition(S.PLAYING);
    f.removePlayer(1);                 // mid-game: slot stays at 1
    assert.equal(f.hostPeerIndex, 1);
    f.endGame([]);                     // -> RESULTS triggers reconcile
    assert.equal(f.hostPeerIndex, 2);  // committed to surviving participant
  });
});

describe('RoomFlow — state machine', () => {
  it('rejects invalid transitions and keeps state', () => {
    const f = new RoomFlow();
    f.addPlayer(1);
    assert.equal(f._transition(S.RESULTS), false); // lobby -> results invalid
    assert.equal(f.state, S.LOBBY);
    assert.equal(f._transition(S.LOBBY), true);     // same-state no-op
  });

  it('endGame stores results and moves to results', () => {
    const f = new RoomFlow();
    f.addPlayer(1);
    f.requestStart(); f._transition(S.PLAYING);
    f.endGame([{ rank: 1, peerIndex: 1 }]);
    assert.equal(f.state, S.RESULTS);
    assert.deepEqual(f.lastResults, [{ rank: 1, peerIndex: 1 }]);
  });

  it('reset clears roster, host, state', () => {
    const f = new RoomFlow();
    f.addPlayer(1); f.addPlayer(2);
    f.requestStart();
    f.reset();
    assert.equal(f.size, 0);
    assert.equal(f.host, null);
    assert.equal(f.state, S.LOBBY);
    assert.equal(f._joinSeq, 0);
  });
});

describe('RoomFlow — countdown', () => {
  it('emits 3..1 then go, then transitions to playing', () => {
    const clock = makeClock();
    const f = new RoomFlow({ countdownSeconds: 3, timers: clock.timers });
    f.addPlayer(1);
    const log = record(f);
    assert.equal(f.requestStart(), true);
    assert.equal(f.state, S.COUNTDOWN);

    const counts = log.filter(e => e[0] === 'countdown').map(e => e[1].remaining);
    assert.deepEqual(counts, [3]);     // first tick is synchronous

    clock.flush();
    const allCounts = log.filter(e => e[0] === 'countdown').map(e => e[1].remaining);
    assert.deepEqual(allCounts, [3, 2, 1]);
    assert.equal(log.some(e => e[0] === 'go'), true);
    assert.equal(f.state, S.PLAYING);
  });

  it('cancelCountdown returns to lobby and never starts the game', () => {
    const clock = makeClock();
    const f = new RoomFlow({ countdownSeconds: 3, timers: clock.timers });
    f.addPlayer(1);
    f.requestStart();
    f.cancelCountdown();
    assert.equal(f.state, S.LOBBY);
    clock.flush();                     // any stale timer must not advance us
    assert.equal(f.state, S.LOBBY);
  });

  it('playAgain re-snapshots participants from results', () => {
    const clock = makeClock();
    const f = new RoomFlow({ countdownSeconds: 1, timers: clock.timers });
    f.addPlayer(1); f.addPlayer(2);
    f.requestStart(); clock.flush();   // playing, order [1,2]
    f.endGame([]);                     // results
    f.addPlayer(3);                    // joins during results
    f.playAgain(); clock.flush();      // re-snapshot should include 3
    assert.equal(f.state, S.PLAYING);
    assert.deepEqual(f._order, [1, 2, 3]);
  });
});
