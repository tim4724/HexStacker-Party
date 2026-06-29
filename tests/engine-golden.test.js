'use strict';

// Engine golden-corpus characterization test.
//
// Replays a fixed, deterministic gameplay timeline (tests/helpers/
// engine-golden-script.js) against the engine and deep-asserts the recorded
// per-step board snapshots + emitted events against a committed JSON fixture.
// This is a behavior-preserving net: the upcoming Phase 2 engine move (soft-drop
// deadline -> board state, hardDrop -> softDropEnd, hard-drop cooldown -> Game
// input layer) must not change ANY snapshot in this corpus. The script
// deliberately avoids the two edges Phase 2 changes (soft-drop auto-end and
// sub-150ms hard-drop throttling), so a green golden across the move proves the
// general-gameplay behavior is unchanged.
//
// Equality: EXACT deep-equality (assert.deepStrictEqual). Record and replay run
// the identical script in the identical engine within the same Node process, so
// every integer, boolean, float (gravityCounter) and FNV grid hash is
// bit-for-bit reproducible. (A cross-engine replay — e.g. JavaScriptCore on
// tvOS — would need the gravityCounter float pinned/rounded; that is out of
// scope here and noted for whoever ports this corpus to JSC.)
//
// Re-record after an INTENTIONAL behavior change:
//   RECORD_GOLDEN=1 node --test tests/engine-golden.test.js
// then review the fixture diff before committing.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGoldenScript } = require('./helpers/engine-golden-script');

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'engine-golden.json');

if (process.env.RECORD_GOLDEN === '1') {
  const fresh = runGoldenScript();
  fs.writeFileSync(FIXTURE_PATH, JSON.stringify(fresh, null, 2) + '\n');
  console.log('[golden] recorded', fresh.steps.length, 'steps to', FIXTURE_PATH);
}

test('engine golden corpus replays exactly against committed fixture', () => {
  assert.ok(fs.existsSync(FIXTURE_PATH),
    'fixture missing — record it with RECORD_GOLDEN=1 node --test tests/engine-golden.test.js');
  const expected = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  const actual = runGoldenScript();

  // Step-count first for a readable failure if the timeline length drifts.
  assert.equal(actual.steps.length, expected.steps.length,
    'step count drifted from the recorded golden');
  assert.equal(actual.seed, expected.seed, 'seed drifted from the recorded golden');

  // Per-step deep-equality, asserted one step at a time so a regression points
  // at the exact update index instead of dumping the whole corpus.
  for (let i = 0; i < expected.steps.length; i++) {
    assert.deepStrictEqual(actual.steps[i], expected.steps[i],
      'golden drift at step ' + i + ' (deltaMs=' + expected.steps[i].deltaMs + ')');
  }

  // Belt-and-suspenders: the whole object must match too (catches metadata).
  assert.deepStrictEqual(actual, expected, 'golden corpus drifted from fixture');
});

test('engine golden script is internally deterministic (record == replay)', () => {
  // Two fresh runs in this process must be identical — guards against any
  // hidden nondeterminism (shared scratch leaks, Date/Math.random) sneaking
  // into the engine and silently invalidating the fixture.
  assert.deepStrictEqual(runGoldenScript(), runGoldenScript());
});

test('engine golden corpus exercises the intended gameplay paths', () => {
  // Documents and enforces what the corpus covers, so a future edit that guts
  // the script (e.g. drops all line clears) fails loudly instead of leaving a
  // hollow net.
  const { steps } = runGoldenScript();
  const eventCounts = {};
  let sawHold = false;
  let sawPendingGarbage = false;
  let sawGarbageApplied = false;
  const prevPending = {};
  for (const step of steps) {
    for (const e of step.events) eventCounts[e.type] = (eventCounts[e.type] || 0) + 1;
    for (const b of step.boards) {
      if (b.holdPiece) sawHold = true;
      if (b.pendingGarbageLines > 0) sawPendingGarbage = true;
      if ((prevPending[b.id] || 0) > 0 && b.pendingGarbageLines === 0) sawGarbageApplied = true;
      prevPending[b.id] = b.pendingGarbageLines;
    }
  }
  assert.ok((eventCounts.piece_lock || 0) > 0, 'corpus locks pieces (gravity/hard_drop -> lock)');
  assert.ok((eventCounts.line_clear || 0) > 0, 'corpus clears at least one line');
  assert.ok((eventCounts.player_ko || 0) > 0, 'corpus drives a KO');
  assert.ok((eventCounts.game_end || 0) > 0, 'corpus reaches game end');
  assert.ok(sawHold, 'corpus exercises hold');
  assert.ok(sawPendingGarbage, 'corpus queues garbage (apply path setup)');
  assert.ok(sawGarbageApplied, 'corpus applies queued garbage on a lock');
});
