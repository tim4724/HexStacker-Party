'use strict';

// Engine purity gate.
//
// The engine (server/*.js) must stay deterministic, seeded and clock-free so it
// runs identically in Node, the browser, and JavaScriptCore (tvOS): no wall
// clock, no timers, no I/O, no DOM. This test fails if any server/*.js file
// references a forbidden host API. Math.random is ALLOWED — it is used only for
// the default seed (Game constructor, Randomizer/GarbageManager rng fallback),
// never for per-tick logic — so it is deliberately not in the forbidden set.
//
// This locks the property in for Phase 2: the engine move must not pull a timer
// or clock into server/ (the 300ms soft-drop / 150ms hard-drop rules become
// deltaMs countdowns, not setTimeout/Date.now).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SERVER_DIR = path.join(__dirname, '..', 'server');

// Forbidden host APIs. Each entry: { name, re }. Kept as anchored-ish regexes so
// substrings inside unrelated identifiers (e.g. "prefetch(", "documented") do
// not false-positive, while the real call shapes do.
const FORBIDDEN = [
  { name: 'Date.now', re: /\bDate\.now\b/ },
  { name: 'setTimeout', re: /\bsetTimeout\b/ },
  { name: 'setInterval', re: /\bsetInterval\b/ },
  { name: 'fetch(', re: /\bfetch\s*\(/ },
  { name: 'WebSocket', re: /\bWebSocket\b/ },          // covers `new WebSocket` and `WebSocket(`
  { name: 'document.', re: /\bdocument\s*\./ },
];

// server/index.js is the Node HTTP host (http/fs/qrcode), not a portable engine
// module — it never runs in the browser or JSC, so it is exempt from the purity
// gate. The portable engine is every other server/*.js (constants, Game,
// PlayerBoard, Piece, Randomizer, GarbageManager).
function serverFiles() {
  return fs.readdirSync(SERVER_DIR)
    .filter((f) => f.endsWith('.js') && f !== 'index.js')
    .map((f) => path.join(SERVER_DIR, f));
}

test('portable engine modules (server/*.js except index.js) contain no clock/timer/IO/DOM host APIs', () => {
  const files = serverFiles();
  assert.ok(files.length > 0, 'expected at least one server/*.js engine file');

  const violations = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const { name, re } of FORBIDDEN) {
        if (re.test(lines[i])) {
          violations.push(path.basename(file) + ':' + (i + 1) + ' references ' + name +
            ' -> ' + lines[i].trim());
        }
      }
    }
  }

  assert.deepStrictEqual(violations, [],
    'engine impurity detected — the engine must be clock-free and deterministic:\n' +
    violations.join('\n'));
});

test('PartyCore.js is covered by the purity gate', () => {
  // PartyCore (the frame() facade) wraps Game and must stay clock-free so it
  // runs in Node, the browser, and JSC/QuickJS on native. serverFiles() globs it
  // automatically; this locks that coverage so a future rename or glob change
  // can't silently drop the facade from the scan.
  const scanned = serverFiles().map((f) => path.basename(f));
  assert.ok(scanned.includes('PartyCore.js'),
    'server/PartyCore.js must be scanned by the purity gate');
});

test('Math.random remains allowed (only as a default-seed source)', () => {
  // Guards the gate's intent: Math.random IS present in the engine (default
  // seed). If a future edit wrongly adds it to FORBIDDEN, this fails — proving
  // the allowance is deliberate, not an accident of pattern choice.
  const present = serverFiles().some((f) => /\bMath\.random\b/.test(fs.readFileSync(f, 'utf8')));
  assert.ok(present, 'expected Math.random to exist in the engine (default seed)');
  assert.ok(!FORBIDDEN.some((p) => p.name.includes('Math.random')),
    'Math.random must not be in the forbidden set');
});
