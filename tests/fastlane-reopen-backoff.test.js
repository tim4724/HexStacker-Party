'use strict';

// The controller's fastlane REOPEN policy (public/controller/ControllerConnection.js):
// when the channel dies with the relay still up, retry at 2 s doubling to 30 s,
// and reset only once a channel has stayed up long enough to prove it. The real
// file runs in a VM context; connect() builds the fastlane, so the callbacks under
// test are the ones the page wires. Only the kit classes and the clock are stubs.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { MSG } = require('../public/shared/protocol');

const SRC = fs.readFileSync(path.join(__dirname, '../public/controller/ControllerConnection.js'), 'utf8');

function load() {
  const timers = new Map();
  let seq = 0;
  const clock = {
    now: 0,
    advance(dt) {
      const end = this.now + dt;
      for (;;) {
        let next = null;
        for (const [id, e] of timers) if (e.at <= end && (!next || e.at < next.e.at)) next = { id, e };
        if (!next) break;
        timers.delete(next.id);
        this.now = next.e.at;
        next.e.fn();
      }
      this.now = end;
    },
  };
  const opens = [];
  let opts = null;
  const ctx = {
    console, URLSearchParams, MSG,
    location: { search: '' }, window: {},
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: clock.now + (ms || 0) }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    RELAY_URL: 'wss://relay.invalid', STUN_URL: 'stun:stun.invalid', roomCode: 'TEST', instanceId: null, clientId: 'c1',
    gameCancelled: false, peerIndex: null, party: null, fastlane: null,
    lastFastlaneRttAt: 0, lastPongRttHalf: null, latencyDisplay: null, onState() {},
    PartyConnection: class { connect() {} close() {} sendTo() {} },
    PartyFastlane: class {
      constructor(o) { opts = o; }
      open() { opens.push(clock.now); return Promise.resolve(); }
      close() {} closeAll() {} setSelfIndex() {}
    },
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  ctx.connect();
  ctx.peerIndex = 1;   // joined
  return { clock, opens, opts };
}

test('ICE that keeps failing backs off 2 s, doubling, capped at 30 s', () => {
  const { clock, opens, opts } = load();
  const gaps = [];
  for (let i = 0; i < 7; i++) {
    const failedAt = clock.now;
    opts.onPeerClosed(0);
    clock.advance(60000);
    gaps.push(opens[i] - failedAt);
  }
  assert.deepEqual(gaps, [2000, 4000, 8000, 16000, 30000, 30000, 30000]);
});

test('a channel the watchdog kills right after it opens does not reset the backoff', () => {
  // Resetting on open restarted every cycle at 2 s: a link that opens and then
  // never acks renegotiated at the floor forever.
  const { clock, opens, opts } = load();
  const gaps = [];
  let diedAt = clock.now;
  opts.onPeerClosed(0);
  for (let i = 0; i < 4; i++) {
    clock.advance(60000);
    gaps.push(opens[i] - diedAt);
    opts.onPeerReady(0);
    clock.advance(3000);   // PartyFastlane's watchdog
    diedAt = clock.now;
    opts.onPeerClosed(0);
  }
  assert.deepEqual(gaps, [2000, 4000, 8000, 16000]);
});

test('a channel that stays up resets the backoff to 2 s', () => {
  const { clock, opens, opts } = load();
  opts.onPeerClosed(0); clock.advance(60000);
  opts.onPeerClosed(0); clock.advance(60000);   // the next retry would be 8 s
  opts.onPeerReady(0);
  clock.advance(10000);
  const diedAt = clock.now;
  opts.onPeerClosed(0);
  clock.advance(60000);
  assert.equal(opens[2] - diedAt, 2000);
});

test('an open cancels the pending retry', () => {
  const { clock, opens, opts } = load();
  opts.onPeerClosed(0);
  opts.onPeerReady(0);   // the channel came up on its own before the retry fired
  clock.advance(60000);
  assert.deepEqual(opens, []);
});
