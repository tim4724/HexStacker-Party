'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { GarbageManager } = require('../server/GarbageManager');

describe('GarbageManager - tick', () => {
  let gm;

  beforeEach(() => {
    gm = new GarbageManager(() => 0.5);
    gm.addPlayer('p1');
    gm.addPlayer('p2');
  });

  test('tick decrements msLeft on queued garbage', () => {
    const queue = gm.queues.get('p1');
    queue.push({ lines: 2, gapColumn: 3, senderId: 'p2', msLeft: 100 });
    gm.tick(20);
    assert.strictEqual(queue[0].msLeft, 80);
  });

  test('tick returns garbage when msLeft reaches 0', () => {
    const queue = gm.queues.get('p1');
    queue.push({ lines: 3, gapColumn: 5, senderId: 'p2', msLeft: 16 });
    const ready = gm.tick(16);
    assert.strictEqual(ready.length, 1);
    assert.strictEqual(ready[0].playerId, 'p1');
    assert.strictEqual(ready[0].lines, 3);
    assert.strictEqual(ready[0].gapColumn, 5);
    assert.strictEqual(ready[0].senderId, 'p2');
    // Should be removed from queue
    assert.strictEqual(queue.length, 0);
  });

  test('tick returns empty array when no garbage is ready', () => {
    const queue = gm.queues.get('p1');
    queue.push({ lines: 2, gapColumn: 3, senderId: 'p2', msLeft: 200 });
    const ready = gm.tick(16);
    assert.strictEqual(ready.length, 0);
    assert.strictEqual(queue.length, 1);
  });

  test('tick processes multiple players independently', () => {
    gm.queues.get('p1').push({ lines: 1, gapColumn: 0, senderId: 'p2', msLeft: 16 });
    gm.queues.get('p2').push({ lines: 2, gapColumn: 4, senderId: 'p1', msLeft: 16 });
    const ready = gm.tick(16);
    assert.strictEqual(ready.length, 2);
    const ids = ready.map(g => g.playerId).sort();
    assert.deepStrictEqual(ids, ['p1', 'p2']);
  });

  test('tick handles multiple garbage entries for same player', () => {
    const queue = gm.queues.get('p1');
    queue.push({ lines: 1, gapColumn: 0, senderId: 'p2', msLeft: 16 });
    queue.push({ lines: 2, gapColumn: 3, senderId: 'p2', msLeft: 48 });
    const ready = gm.tick(16);
    assert.strictEqual(ready.length, 1);
    assert.strictEqual(ready[0].lines, 1);
    assert.strictEqual(queue.length, 1);
    assert.strictEqual(queue[0].msLeft, 32);
  });

  test('multiple ticks count down correctly', () => {
    const queue = gm.queues.get('p1');
    queue.push({ lines: 4, gapColumn: 7, senderId: 'p2', msLeft: 48 });
    assert.strictEqual(gm.tick(16).length, 0);
    assert.strictEqual(gm.tick(16).length, 0);
    const ready = gm.tick(16);
    assert.strictEqual(ready.length, 1);
    assert.strictEqual(ready[0].lines, 4);
  });
});

describe('GarbageManager - processLineClear delivery', () => {
  let gm;

  beforeEach(() => {
    gm = new GarbageManager(() => 0.5);
    gm.addPlayer('p1');
    gm.addPlayer('p2');
    gm.addPlayer('p3');
  });

  test('sends garbage to opponent with lowest stack', () => {
    const result = gm.processLineClear('p1', 4, (id) => {
      return id === 'p2' ? 5 : 10;
    });
    assert.strictEqual(result.sent > 0, true);
    assert.strictEqual(result.deliveries[0].toId, 'p2');
  });

  test('garbage cancels incoming before sending', () => {
    gm.queues.get('p1').push({ lines: 2, gapColumn: 0, senderId: 'p2', msLeft: 100 });
    const result = gm.processLineClear('p1', 4, () => 5);
    assert.strictEqual(result.cancelled, 2);
  });

  test('no garbage sent for 0 lines cleared', () => {
    const result = gm.processLineClear('p1', 0, () => 5);
    assert.deepStrictEqual(result, { sent: 0, cancelled: 0, deliveries: [] });
  });

  test('quad sends 4 garbage', () => {
    const result = gm.processLineClear('p1', 4, () => 5);
    assert.strictEqual(result.sent, 4);
  });

  test('single sends 0 garbage', () => {
    const result = gm.processLineClear('p1', 1, () => 5);
    assert.strictEqual(result.sent, 0);
  });

  test('double sends 1 garbage', () => {
    const result = gm.processLineClear('p1', 2, () => 5);
    assert.strictEqual(result.sent, 1);
  });

  test('triple sends 2 garbage', () => {
    const result = gm.processLineClear('p1', 3, () => 5);
    assert.strictEqual(result.sent, 2);
  });
});

describe('GarbageManager - cancellation', () => {
  let gm;

  beforeEach(() => {
    gm = new GarbageManager(() => 0.5);
    gm.addPlayer('p1');
    gm.addPlayer('p2');
  });

  test('incoming garbage is cancelled before sending remainder', () => {
    gm.queues.get('p1').push({ lines: 1, gapColumn: 0, senderId: 'p2', msLeft: 100 });
    const result = gm.processLineClear('p1', 4, () => 5);
    assert.strictEqual(result.cancelled, 1);
    assert.strictEqual(result.sent, 3);
  });

  test('partial cancellation: remaining garbage stays in queue', () => {
    gm.queues.get('p1').push({ lines: 3, gapColumn: 0, senderId: 'p2', msLeft: 100 });
    const result = gm.processLineClear('p1', 1, () => 5);
    assert.strictEqual(result.cancelled, 1);
    assert.strictEqual(result.sent, 0);
    assert.strictEqual(gm.queues.get('p1')[0].lines, 2);
  });

  test('single clear cancels 1 incoming garbage line', () => {
    gm.queues.get('p1').push({ lines: 2, gapColumn: 0, senderId: 'p2', msLeft: 100 });
    const result = gm.processLineClear('p1', 1, () => 5);
    assert.strictEqual(result.cancelled, 1);
    assert.strictEqual(gm.queues.get('p1')[0].lines, 1);
  });
});

describe('GarbageManager - target selection', () => {
  test('garbage targets lowest stack when multiple opponents exist', () => {
    const gm = new GarbageManager(() => 0.5);
    gm.addPlayer('p1');
    gm.addPlayer('p2');
    gm.addPlayer('p3');
    const result = gm.processLineClear('p1', 2, (id) => {
      return id === 'p2' ? 12 : 3;
    });
    assert.strictEqual(result.deliveries[0].toId, 'p3');
  });
});

describe('GarbageManager - defenseLines parameter', () => {
  let gm;

  beforeEach(() => {
    gm = new GarbageManager(() => 0.5);
    gm.addPlayer('p1');
    gm.addPlayer('p2');
  });

  test('defenseLines limits queue cancellation independently of attack', () => {
    gm.queues.get('p1').push({ lines: 4, gapColumn: 0, senderId: 'p2', msLeft: 100 });
    const result = gm.processLineClear('p1', 4, () => 5, 2);
    assert.strictEqual(result.cancelled, 2);
    assert.strictEqual(gm.queues.get('p1')[0].lines, 2);
  });

  test('defenseLines=null falls back to linesCleared', () => {
    gm.queues.get('p1').push({ lines: 4, gapColumn: 0, senderId: 'p2', msLeft: 100 });
    const result = gm.processLineClear('p1', 4, () => 5, null);
    assert.strictEqual(result.cancelled, 4);
  });

  test('defenseLines undefined falls back to linesCleared', () => {
    gm.queues.get('p1').push({ lines: 4, gapColumn: 0, senderId: 'p2', msLeft: 100 });
    const result = gm.processLineClear('p1', 4, () => 5);
    assert.strictEqual(result.cancelled, 4);
  });
});
