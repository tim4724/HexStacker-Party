'use strict';

// PartyCore command-VOCABULARY golden test.
//
// The shared frame() golden (partycore-frame.test.js) runs at level 1 with
// single-line clears, so it never emits three host-effect commands: musicSpeed,
// garbageCancelled, and garbageSent. This dedicated golden pins them with small
// hermetic scenarios (tests/helpers/partycore-commands-script.js) and:
//   (1) replays each scenario's per-frame { deltaMs, events, commands } against a
//       committed fixture with exact deep-equality;
//   (2) gates that EACH target command type actually appears (a coverage net, so
//       a future edit that stops emitting one fails loudly instead of silently
//       hollowing the corpus — like engine-golden's "exercises ..." test);
//   (3) checks the driver is internally deterministic (record == replay).
//
// This NEVER touches tests/fixtures/partycore-frame-golden.json or
// engine-golden.json (both stay byte-identical — this is a NEW, additive fixture).
//
// Re-record after an INTENTIONAL command-mapping change:
//   RECORD_PARTYCORE_COMMANDS_GOLDEN=1 node --test tests/partycore-commands.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runCommandVocabularyScript } = require('./helpers/partycore-commands-script');

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'partycore-commands-golden.json');

if (process.env.RECORD_PARTYCORE_COMMANDS_GOLDEN === '1') {
  const fresh = runCommandVocabularyScript();
  fs.writeFileSync(FIXTURE_PATH, JSON.stringify(fresh, null, 2) + '\n');
  console.log('[partycore-commands] recorded', fresh.scenarios.length, 'scenarios to', FIXTURE_PATH);
}

test('PartyCore command-vocabulary golden replays exactly against committed fixture', () => {
  assert.ok(fs.existsSync(FIXTURE_PATH),
    'fixture missing — record it with RECORD_PARTYCORE_COMMANDS_GOLDEN=1 node --test tests/partycore-commands.test.js');
  const expected = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  const actual = runCommandVocabularyScript();

  assert.equal(actual.seed, expected.seed, 'seed drifted from the recorded golden');
  assert.equal(actual.scenarios.length, expected.scenarios.length, 'scenario count drifted');
  for (let i = 0; i < expected.scenarios.length; i++) {
    assert.deepStrictEqual(actual.scenarios[i], expected.scenarios[i],
      'command-vocabulary golden drift in scenario "' + expected.scenarios[i].name + '"');
  }
  assert.deepStrictEqual(actual, expected, 'command-vocabulary golden corpus drifted from fixture');
});

test('command-vocabulary driver is internally deterministic (record == replay)', () => {
  assert.deepStrictEqual(runCommandVocabularyScript(), runCommandVocabularyScript());
});

test('command-vocabulary golden covers musicSpeed, garbageCancelled, and garbageSent', () => {
  // Coverage gate: these three are exactly the commands the shared frame() golden
  // cannot reach. If any stops being emitted, this corpus must fail loudly.
  const { scenarios } = runCommandVocabularyScript();
  const seen = new Set();
  for (const scenario of scenarios) {
    for (const step of scenario.steps) {
      for (const cmd of step.commands) seen.add(cmd.type);
    }
  }
  for (const type of ['musicSpeed', 'garbageCancelled', 'garbageSent']) {
    assert.ok(seen.has(type), 'corpus must emit a ' + type + ' command');
  }
});
