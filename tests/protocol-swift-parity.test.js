'use strict';

// Apple TV <-> web protocol/constants lockstep guard.
//
// appletv/Sources/HexStackerKit/Net/Protocol.swift hand-mirrors the wire
// protocol from public/shared/protocol.js. A drifted message-type string is a
// silent production bug (a typo'd type is just an ignored message), so this
// gate re-derives every mirrored value from the canonical JS and fails on any
// mismatch. It is the Swift analog of tests/protocol-android-parity.test.js
// and uses the same technique: the values are compile-time constants, so
// narrow regexes over the source text are the honest place to read them.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { MSG, INPUT, ROOM_STATE, RELAY_URL, STUN_URL } = require('../public/shared/protocol.js');
const constants = require('../server/constants.js');

const ROOT = path.join(__dirname, '..');
const SWIFT = read('appletv/Sources/HexStackerKit/Net/Protocol.swift');

function read(p) {
  return fs.readFileSync(path.join(ROOT, p), 'utf8');
}

/** The body of `public enum <name> ... { ... }` (these enums have no nested braces). */
function swiftEnum(name) {
  const m = SWIFT.match(new RegExp(`public enum ${name}[^{]*\\{([\\s\\S]*?)\\n\\}`));
  assert.ok(m, `Swift enum ${name} not found`);
  return m[1];
}

/** `static let name = "value"` pairs -> { name: 'value' }. */
function swiftStringConsts(block) {
  const out = {};
  for (const m of block.matchAll(/static let (\w+) = "([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

/** Swift camelCase const name -> the JS UPPER_SNAKE key (rotateCW -> ROTATE_CW). */
function upperSnake(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

/** Raw-string enum cases (`case left` / `case rotateCW = "rotate_cw"`) -> { NAME: 'wire' }. */
function swiftWireEnum(block) {
  const out = {};
  for (const m of block.matchAll(/^\s*case (\w+)(?:\s*=\s*"([^"]+)")?\s*$/gm)) {
    out[upperSnake(m[1])] = m[2] !== undefined ? m[2] : m[1];
  }
  return out;
}

test('MSG strings mirror protocol.js MSG', () => {
  const problems = [];
  const consts = swiftStringConsts(swiftEnum('MSG'));
  for (const [name, value] of Object.entries(consts)) {
    if (name === 'heartbeat') continue; // display-internal, not in MSG (checked below)
    const key = upperSnake(name);
    if (MSG[key] === undefined) problems.push(`MSG.${name}: no MSG.${key} in protocol.js`);
    else if (MSG[key] !== value) problems.push(`MSG.${name}: '${value}' != web '${MSG[key]}'`);
  }
  assert.deepStrictEqual(problems, []);
});

test('the display heartbeat canary and clientId match the web display', () => {
  const displayConnection = read('public/display/DisplayConnection.js');
  assert.strictEqual(swiftStringConsts(swiftEnum('MSG')).heartbeat, '_heartbeat');
  assert.ok(displayConnection.includes("'_heartbeat'"), 'web display no longer uses _heartbeat');
  assert.strictEqual(swiftStringConsts(swiftEnum('Protocol')).displayClientId, 'display');
  assert.ok(displayConnection.includes("clientId: 'display'"), "web display no longer uses clientId 'display'");
});

test('RoomState and InputAction wire values mirror protocol.js', () => {
  assert.deepStrictEqual(swiftWireEnum(swiftEnum('RoomState')), ROOM_STATE, 'RoomState wire values');
  assert.deepStrictEqual(swiftWireEnum(swiftEnum('InputAction')), INPUT, 'InputAction wire values');
});

test('relay endpoints and limits mirror the web', () => {
  const proto = swiftStringConsts(swiftEnum('Protocol'));
  assert.strictEqual(proto.relayURL, RELAY_URL);
  assert.strictEqual(proto.stunURL, STUN_URL);
  // Display slot 0 + MAX_PLAYERS controllers, same as the web's create call
  // (pinned to the web source in tests/protocol-android-parity.test.js).
  const maxClients = SWIFT.match(/static let maxClients = (\d+)/);
  assert.ok(maxClients, 'Swift const maxClients not found');
  assert.strictEqual(Number(maxClients[1]), constants.MAX_PLAYERS + 1);
});

test('the controller base URL matches the Android mirror', () => {
  // The web display derives the QR join URL from window.location, so there is
  // no canonical JS constant; the two native mirrors must at least agree with
  // each other.
  const kotlin = read('android/core/src/commonMain/kotlin/com/hexstacker/core/net/Protocol.kt');
  const kt = kotlin.match(/const val CONTROLLER_BASE_URL = "([^"]*)"/);
  assert.ok(kt, 'Kotlin const CONTROLLER_BASE_URL not found');
  assert.strictEqual(swiftStringConsts(swiftEnum('Protocol')).controllerBaseURL, kt[1]);
});
