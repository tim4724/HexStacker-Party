#!/usr/bin/env node
'use strict';

// Bundles the PartyCore frame() golden DRIVER (tests/helpers/partycore-frame-script.js)
// into a single QuickJS-loadable iife exposing globalThis.HexFrameTest, so the
// native ports can run the EXACT same deterministic timeline that produced
// tests/fixtures/partycore-frame-golden.json and assert byte-for-byte parity.
//
// This is the cross-engine conformance harness: if QuickJS (Android) / JSC
// (tvOS) reproduce the V8-recorded golden, the canonical engine is faithful on
// that engine. Output is git-ignored (regenerated from canonical JS, cannot
// drift). Reuses scripts/build.js coreOptions (only the entry/global/outfile
// differ) so this bundle can't drift from the config dist/partycore.js ships with.

const path = require('path');
const esbuild = require('esbuild');
const { coreOptions } = require('./build.js');

const ROOT = path.join(__dirname, '..');

esbuild.build(coreOptions({
  entryPoints: [path.join(ROOT, 'tests', 'helpers', 'partycore-frame-script.js')],
  globalName: 'HexFrameTest',
  outfile: path.join(ROOT, 'dist', 'partycore-frame-test.js'),
})).then(function () {
  console.log('build: dist/partycore-frame-test.js');
}).catch(function (err) {
  console.error(err);
  process.exit(1);
});
