'use strict';

// GalleryFixtures is the single fixture source for the cross-platform screen
// gallery (scripts/gallery/): every platform renders these snapshots, so they
// must be deterministic (same output on every call — the cross-engine
// byte-exactness itself is covered by the frame-golden conformance tests) and
// hold the invariants the variant specs promise (levels, KO, garbage meters).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { GalleryFixtures } = require('../server/GalleryFixtures');

const VARIANT_NAMES = ['solo', 'lv1', 'lv8', 'lv12', '2p', '3p', '4p'];

test('roster is stable and slot == colorIndex == id', () => {
  const r = GalleryFixtures.roster(8);
  assert.equal(r.length, 8);
  assert.deepEqual(r.map((p) => p.name), GalleryFixtures.NAMES);
  for (let i = 0; i < r.length; i++) {
    assert.equal(r[i].id, i);
    assert.equal(r[i].slot, i);
  }
});

test('every variant snapshot is deterministic and JSON-serializable', () => {
  for (const name of VARIANT_NAMES) {
    const spec = GalleryFixtures.gameVariant(name);
    assert.ok(spec, `unknown variant ${name}`);
    const a = GalleryFixtures.gameSnapshot(spec);
    const b = GalleryFixtures.gameSnapshot(GalleryFixtures.gameVariant(name));
    assert.deepEqual(a, JSON.parse(JSON.stringify(a)), `${name}: must be plain data`);
    assert.deepEqual(a, b, `${name}: two builds must be identical`);
  }
});

test('variant snapshots honour their spec (players, levels, ko, garbage, elapsed)', () => {
  for (const name of VARIANT_NAMES) {
    const spec = GalleryFixtures.gameVariant(name);
    const snap = GalleryFixtures.gameSnapshot(spec);
    assert.equal(snap.players.length, spec.players, `${name}: player count`);
    assert.equal(snap.elapsed, spec.elapsed, `${name}: elapsed`);
    for (let i = 0; i < spec.players; i++) {
      const p = snap.players[i];
      assert.equal(p.id, i, `${name}: ids are slot ints`);
      assert.equal(p.level, spec.levels[i], `${name}: board ${i} level`);
      const shouldBeKO = (spec.ko || []).includes(i);
      assert.equal(p.alive, !shouldBeKO, `${name}: board ${i} alive`);
      const wantGarbage = (spec.garbage || {})[i] || 0;
      if (wantGarbage) {
        assert.ok(p.pendingGarbage >= wantGarbage, `${name}: board ${i} garbage meter`);
      }
      const filled = p.grid.flat().filter((c) => c !== 0).length;
      assert.ok(filled > 10, `${name}: board ${i} has a visible stack (${filled} cells)`);
    }
  }
});

test('ambient pieces are deterministic and inside the 1920x1080 reference band', () => {
  const a = GalleryFixtures.ambientPieces();
  const b = GalleryFixtures.ambientPieces();
  assert.deepEqual(a, b, 'two calls must be identical');
  assert.equal(a.length, 16);
  for (const p of a) {
    assert.ok(Number.isInteger(p.typeId) && p.typeId >= 1, 'typeId is a palette index');
    assert.ok(Array.isArray(p.cells) && p.cells.length >= 3, 'cells carry a piece shape');
    assert.ok(p.x >= 0 && p.x <= 1920, `x in range (${p.x})`);
    assert.ok(p.y >= -80 && p.y <= 1160, `y in the spill band (${p.y})`);
    assert.ok([12, 16, 20, 24, 28, 32].includes(p.size), 'size from the discrete set');
    assert.ok(p.opacity >= 0.14 && p.opacity <= 0.22, 'opacity in the live band');
  }
});

test('results mirror the historic web ranking formula', () => {
  const r = GalleryFixtures.results(4);
  assert.equal(r.results.length, 4);
  assert.deepEqual(r.results.map((x) => x.rank), [1, 2, 3, 4]);
  assert.deepEqual(r.results.map((x) => x.lines), [30, 27, 24, 21]);
  assert.deepEqual(r.results.map((x) => x.level), [4, 3, 2, 1]);
  const solo = GalleryFixtures.results(1);
  assert.equal(solo.results.length, 1);
  assert.equal(solo.results[0].playerName, 'Emma');
});
