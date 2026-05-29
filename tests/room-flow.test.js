'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const RoomFlow = require('../partyplug/RoomFlow');
const S = RoomFlow.STATES;

// Record every emitted event as [type, detail].
function record(flow) {
  const log = [];
  flow.on('*', (type, detail) => log.push([type, detail]));
  return log;
}

describe('RoomFlow — roster', () => {
  it('starts empty in lobby', () => {
    const f = new RoomFlow();
    assert.equal(f.state, S.LOBBY);
    assert.equal(f.size, 0);
    assert.equal(f.host, null);
  });

  it('stores opaque game fields, assigns joinedAt/connected, first joiner is host', () => {
    const f = new RoomFlow();
    // RoomFlow never reads these fields (color/name/level are game data).
    const a = f.addPlayer(10, { name: 'A', colorIndex: 3, startLevel: 5 });
    const b = f.addPlayer(11, { name: 'B', colorIndex: 0 });
    assert.equal(a.colorIndex, 3);        // passed through untouched
    assert.equal(a.startLevel, 5);
    assert.equal(a.connected, true);
    assert.equal(a.joinedAt < b.joinedAt, true);
    assert.equal(f.host, 10);
    assert.equal(f.connectedCount, 2);
  });

  it('lets the game mutate fields on the live record', () => {
    const f = new RoomFlow();
    f.addPlayer(1, { startLevel: 1 });
    f.get(1).startLevel = 9;             // game writes directly
    assert.equal(f.players.get(1).startLevel, 9);
  });

  it('reconnecting the same peerIndex keeps joinedAt/host and merges fields', () => {
    const f = new RoomFlow();
    f.addPlayer(1, { name: 'A' });
    f.addPlayer(2, { name: 'B' });
    const before = f.get(1).joinedAt;
    f.markDisconnected(1);
    assert.equal(f.isDisconnected(1), true);
    const again = f.addPlayer(1, { name: 'A2' });
    assert.equal(again.joinedAt, before);
    assert.equal(again.name, 'A2');
    assert.equal(f.isDisconnected(1), false);
    assert.equal(f.host, 1);
  });
});

describe('RoomFlow — rekey (reconnect claim)', () => {
  it('moves a record to a new peerIndex, preserving fields and host', () => {
    const f = new RoomFlow();
    f.addPlayer(1, { name: 'A', colorIndex: 2 });
    f.addPlayer(2, { name: 'B' });
    f.transitionTo(S.COUNTDOWN); f.transitionTo(S.PLAYING);  // order [1,2]
    f.markDisconnected(1);                         // host blips mid-game
    f.addPlayer(5, { name: 'A-again' });           // returns under a new slot
    assert.equal(f.rekey(1, 5), true);
    assert.equal(f.has(1), false);
    assert.equal(f.get(5).name, 'A');              // original record kept
    assert.equal(f.get(5).colorIndex, 2);
    assert.equal(f.hostPeerIndex, 5);              // host slot followed
    assert.deepEqual(f._order, [5, 2]);            // participant order rekeyed
  });

  it('is a no-op for unknown ids', () => {
    const f = new RoomFlow();
    f.addPlayer(1);
    assert.equal(f.rekey(9, 8), false);
    assert.equal(f.rekey(1, 1), false);
  });

  it('rekeys to a brand-new id with no placeholder slot', () => {
    const f = new RoomFlow();
    f.addPlayer(1, { name: 'A' });   // sole player + host
    assert.equal(f.rekey(1, 7), true);
    assert.equal(f.get(7).name, 'A');
    assert.equal(f.hostPeerIndex, 7);
  });

  it('rekeys the host slot in lobby (no active order)', () => {
    const f = new RoomFlow();
    f.addPlayer(1); f.addPlayer(2);
    f.markDisconnected(1);
    f.addPlayer(9);
    assert.equal(f.rekey(1, 9), true);
    assert.equal(f.hostPeerIndex, 9);
  });

  it('supports a double rekey', () => {
    const f = new RoomFlow();
    f.addPlayer(1, { name: 'A' });
    assert.equal(f.rekey(1, 5), true);
    assert.equal(f.rekey(5, 6), true);
    assert.equal(f.get(6).name, 'A');
    assert.equal(f.hostPeerIndex, 6);
  });

  it('does not emit hostchange when a non-host player is rekeyed', () => {
    const f = new RoomFlow();
    f.addPlayer(1); f.addPlayer(2);          // 1 is host
    f.transitionTo(S.COUNTDOWN); f.transitionTo(S.PLAYING);
    f.markDisconnected(2);
    f.addPlayer(8);
    const log = record(f);
    f.rekey(2, 8);                           // 2 is not the host
    assert.equal(log.some(e => e[0] === 'hostchange'), false);
  });
});

describe('RoomFlow — clearDisconnected', () => {
  it('clears all disconnect flags and marks everyone present', () => {
    const f = new RoomFlow();
    f.addPlayer(1); f.addPlayer(2);
    f.markDisconnected(1); f.markDisconnected(2);
    const log = record(f);
    f.clearDisconnected();
    assert.equal(f.isDisconnected(1), false);
    assert.equal(f.isDisconnected(2), false);
    assert.equal(f.get(1).connected, true);
    assert.equal(log.some(e => e[0] === 'rosterchange'), true);
  });

  it('is a no-op (no event) when nobody is disconnected', () => {
    const f = new RoomFlow();
    f.addPlayer(1);
    const log = record(f);
    f.clearDisconnected();
    assert.equal(log.length, 0);
  });
});

describe('RoomFlow — event ordering', () => {
  it('emits playerjoin before rosterchange (non-first player)', () => {
    const f = new RoomFlow();
    f.addPlayer(1);                 // first joiner (also hostchange)
    const log = record(f);
    f.addPlayer(2);
    const types = log.map(e => e[0]);
    assert.ok(types.indexOf('playerjoin') < types.indexOf('rosterchange'));
    assert.equal(types.includes('hostchange'), false);
  });

  it('emits playerleave before rosterchange', () => {
    const f = new RoomFlow();
    f.addPlayer(1); f.addPlayer(2);
    const log = record(f);
    f.removePlayer(2);             // non-host leave in lobby
    const types = log.map(e => e[0]);
    assert.ok(types.indexOf('playerleave') < types.indexOf('rosterchange'));
  });
});

describe('RoomFlow — host election', () => {
  it('elects next oldest when host leaves in lobby', () => {
    const f = new RoomFlow();
    f.addPlayer(1); f.addPlayer(2); f.addPlayer(3);
    assert.equal(f.host, 1);
    f.removePlayer(1);
    assert.equal(f.host, 2);
    assert.equal(f.hostPeerIndex, 2);
  });

  it('keeps the sticky slot when host leaves mid-game; getter falls back', () => {
    const f = new RoomFlow();
    f.addPlayer(1); f.addPlayer(2);
    f.transitionTo(S.COUNTDOWN); f.transitionTo(S.PLAYING);
    f.removePlayer(1);
    assert.equal(f.hostPeerIndex, 1);  // slot untouched
    assert.equal(f.host, 2);           // effective host falls back
  });

  it('a late joiner cannot become host mid-game', () => {
    const f = new RoomFlow();
    f.addPlayer(1); f.addPlayer(2);
    f.transitionTo(S.COUNTDOWN); f.transitionTo(S.PLAYING);  // order [1,2]
    f.addPlayer(3);                               // late joiner
    f.markDisconnected(1); f.markDisconnected(2);
    assert.equal(f.host, null);                   // 3 is excluded
  });

  it('uses masterProvider when eligible, ignores it when not', () => {
    let master = 2;
    const f = new RoomFlow({ masterProvider: () => master });
    f.addPlayer(1); f.addPlayer(2);
    assert.equal(f.host, 2);
    master = 999;
    assert.equal(f.host, 1);
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
    f.transitionTo(S.COUNTDOWN); f.transitionTo(S.PLAYING);
    f.removePlayer(1);
    assert.equal(f.hostPeerIndex, 1);
    f.endGame([]);
    assert.equal(f.hostPeerIndex, 2);
  });
});

describe('RoomFlow — active order', () => {
  it('setActiveOrder syncs host eligibility with a game-owned order', () => {
    const f = new RoomFlow();
    f.addPlayer(1); f.addPlayer(2); f.addPlayer(3);
    f.transitionTo(S.COUNTDOWN);     // auto-snapshots [1,2,3]
    f.setActiveOrder([2, 3]);        // game says only 2,3 are participants
    f.markDisconnected(2);
    assert.equal(f.host, 3);         // 1 excluded (not a participant), 2 gone
  });

  it('setActiveOrder drops ids not in the roster', () => {
    const f = new RoomFlow();
    f.addPlayer(1);
    f.setActiveOrder([1, 99]);
    assert.deepEqual(f._order, [1]);
  });
});

describe('RoomFlow — state machine', () => {
  it('rejects invalid transitions and keeps state', () => {
    const f = new RoomFlow();
    f.addPlayer(1);
    assert.equal(f.transitionTo(S.RESULTS), false); // lobby -> results invalid
    assert.equal(f.state, S.LOBBY);
    assert.equal(f.transitionTo(S.LOBBY), true);     // same-state no-op
  });

  it('endGame stores results and moves to results', () => {
    const f = new RoomFlow();
    f.addPlayer(1);
    f.transitionTo(S.COUNTDOWN); f.transitionTo(S.PLAYING);
    f.endGame([{ rank: 1, peerIndex: 1 }]);
    assert.equal(f.state, S.RESULTS);
    assert.deepEqual(f.lastResults, [{ rank: 1, peerIndex: 1 }]);
  });

  it('reset clears roster, host, state', () => {
    const f = new RoomFlow();
    f.addPlayer(1); f.addPlayer(2);
    f.transitionTo(S.COUNTDOWN);
    f.reset();
    assert.equal(f.size, 0);
    assert.equal(f.host, null);
    assert.equal(f.state, S.LOBBY);
    assert.equal(f._joinSeq, 0);
  });
});

describe('RoomFlow — order re-snapshot on COUNTDOWN', () => {
  it('re-snapshots the participant order each time COUNTDOWN is entered', () => {
    const f = new RoomFlow();
    f.addPlayer(1); f.addPlayer(2);
    f.transitionTo(S.COUNTDOWN); f.transitionTo(S.PLAYING);  // order [1,2]
    f.endGame([]);                       // results
    f.addPlayer(3);                      // joins during results
    f.transitionTo(S.COUNTDOWN);         // re-snapshot should include 3
    assert.deepEqual(f._order, [1, 2, 3]);
  });
});
