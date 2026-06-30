'use strict';

// Runtime portable-core gate — the executable companion to the STATIC scan in
// portable-purity.test.js. That test greps source for forbidden host APIs; this
// one bundles the core and proves the ARTIFACT actually loads and runs inside a
// bare JS engine (the tvOS JavaScriptCore / Android TV QuickJS target): a context
// with the ECMAScript intrinsics every engine has (Object/Array/JSON/Math/Date/
// Map/...), but NONE of the host APIs JSC lacks — no require, no window, no
// document, no setTimeout/setInterval, no console.
//
// It bundles server/core-entry.js with the SAME esbuild options build.js ships
// (write:false, in memory) so this gate can never drift from the real artifact.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const esbuild = require('esbuild');
const { coreOptions } = require('../scripts/build.js');

async function bundleCore() {
  // write:false bundles in memory with the SAME options build.js ships, minus
  // the sourcemap the on-disk artifact carries (this gate proves the bundle
  // RUNS in a bare engine, not that it has a map). outputFiles[0] is the JS.
  const result = await esbuild.build(coreOptions({ write: false }));
  return result.outputFiles[0].text;
}

test('core bundle loads + runs frames in a bare engine context (no require/window/DOM/timers)', async () => {
  const src = await bundleCore();

  // The contextified object IS the global. vm gives it the ECMAScript intrinsics
  // automatically; we add nothing host-specific, so require/window/document/
  // setTimeout/setInterval/console are genuinely absent — modelling JSC/QuickJS.
  const sandbox = {};
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'partycore.bundle.js' });

  const ns = sandbox.HexCore;
  assert.ok(ns, 'bundle must expose globalThis.HexCore');
  assert.equal(typeof ns.PartyCore, 'function', 'HexCore.PartyCore must be a constructor');
  assert.equal(typeof ns.RoomFlow, 'function', 'HexCore.RoomFlow must be a constructor');

  // Drive the native integration surface headlessly: construct, init, prime the
  // injected clock, advance one ~60Hz step.
  const roster = new Map([[0, { startLevel: 1 }], [1, { startLevel: 1 }]]);
  const pc = new ns.PartyCore(roster, 12345);
  pc.init();
  pc.frame(0);
  const r = pc.frame(16);

  assert.deepEqual(Object.keys(r).sort(), ['commands', 'events', 'snapshot']);
  assert.equal(r.snapshot.players.length, 2, 'snapshot carries both players');
  assert.ok(Array.isArray(r.events), 'events is an array');
  assert.ok(Array.isArray(r.commands), 'commands is an array');
});
