'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Randomizer } = require('../server/Randomizer');

const ALL_TYPES = ['I', 'O', 'S', 'Z', 'q', 'p', 'L', 'J'];
const BAG_SIZE = ALL_TYPES.length;

function drawBag(randomizer) {
  return Array.from({ length: BAG_SIZE }, () => randomizer.next());
}

describe('Randomizer - bag fairness', () => {
  test('first bag contains all types exactly once', () => {
    const randomizer = new Randomizer();
    const pieces = drawBag(randomizer);
    const counts = {};
    for (const p of pieces) counts[p] = (counts[p] || 0) + 1;

    for (const type of ALL_TYPES) {
      assert.strictEqual(counts[type], 1, `First bag should contain exactly one ${type}`);
    }
  });

  test('second bag also contains all types exactly once', () => {
    const randomizer = new Randomizer();
    drawBag(randomizer); // discard first bag
    const pieces = drawBag(randomizer);
    const counts = {};
    for (const p of pieces) counts[p] = (counts[p] || 0) + 1;

    for (const type of ALL_TYPES) {
      assert.strictEqual(counts[type], 1, `Second bag should contain exactly one ${type}`);
    }
  });

  test('pieces across 104 draws contain each type equally', () => {
    const randomizer = new Randomizer();
    const totalPieces = BAG_SIZE * 13; // 13 full bags = 104
    const counts = {};
    for (const type of ALL_TYPES) counts[type] = 0;

    for (let i = 0; i < totalPieces; i++) {
      const type = randomizer.next();
      counts[type]++;
    }

    // With exactly 13 full bags, each type must appear exactly 13 times
    for (const type of ALL_TYPES) {
      assert.strictEqual(counts[type], 13,
        `${type} count ${counts[type]} should be 13 over ${totalPieces} pieces`);
    }
  });

  test('each piece produced is a valid type', () => {
    const randomizer = new Randomizer();
    for (let i = 0; i < BAG_SIZE * 7; i++) {
      const type = randomizer.next();
      assert.ok(ALL_TYPES.includes(type), `${type} should be a valid piece type`);
    }
  });

  test('consecutive bags are independently shuffled', () => {
    const randomizer = new Randomizer();
    for (let bag = 0; bag < 5; bag++) {
      const pieces = drawBag(randomizer);
      const sorted = [...pieces].sort();
      assert.deepStrictEqual(sorted, [...ALL_TYPES].sort(), `Bag ${bag + 1} should be a full set`);
    }
  });
});

describe('Randomizer - seeded determinism', () => {
  test('two randomizers with same seed produce identical sequences', () => {
    const a = new Randomizer(42);
    const b = new Randomizer(42);
    for (let i = 0; i < BAG_SIZE * 10; i++) {
      assert.strictEqual(a.next(), b.next(), `Piece ${i + 1} should match`);
    }
  });

  test('different seeds produce different sequences', () => {
    const a = new Randomizer(1);
    const b = new Randomizer(2);
    const seqA = Array.from({ length: BAG_SIZE * 2 }, () => a.next());
    const seqB = Array.from({ length: BAG_SIZE * 2 }, () => b.next());
    assert.notDeepStrictEqual(seqA, seqB);
  });

  test('seeded randomizer still produces valid bags', () => {
    const randomizer = new Randomizer(12345);
    for (let bag = 0; bag < 5; bag++) {
      const pieces = drawBag(randomizer);
      const sorted = [...pieces].sort();
      assert.deepStrictEqual(sorted, [...ALL_TYPES].sort(), `Seeded bag ${bag + 1} should be a full set`);
    }
  });
});
