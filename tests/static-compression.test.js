'use strict';

// Pins the Accept-Encoding negotiation that fronts the pre-compressed web
// bundles (scripts/build.js emits `.br`/`.gz` siblings; server/index.js picks
// one per request). Both pieces are pure and exported, so no server boot is
// needed — the end-to-end serving (real bundle over the wire) is covered by the
// e2e suite, which runs against SERVE_BUNDLES=1.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pickEncoding, HASHED_BUNDLE } = require('../server/index.js');

test('pickEncoding prefers brotli over gzip', () => {
  assert.deepEqual(pickEncoding('gzip, deflate, br'), { ext: '.br', name: 'br' });
});

test('pickEncoding falls back to gzip when brotli is absent', () => {
  assert.deepEqual(pickEncoding('gzip, deflate'), { ext: '.gz', name: 'gzip' });
});

test('pickEncoding returns null when neither is accepted', () => {
  assert.equal(pickEncoding('identity'), null);
  assert.equal(pickEncoding(''), null);
  assert.equal(pickEncoding(undefined), null);
});

test('pickEncoding honors q=0 as an explicit refusal', () => {
  assert.deepEqual(pickEncoding('br;q=0, gzip'), { ext: '.gz', name: 'gzip' });
  assert.equal(pickEncoding('br;q=0, gzip;q=0'), null);
  assert.equal(pickEncoding('br;q=0.0'), null);
  assert.deepEqual(pickEncoding('br;q=0.5'), { ext: '.br', name: 'br' });
});

test('pickEncoding honors the * wildcard and its q-value', () => {
  assert.deepEqual(pickEncoding('*'), { ext: '.br', name: 'br' });
  assert.equal(pickEncoding('*;q=0'), null);
  // An explicit token overrides the wildcard default.
  assert.deepEqual(pickEncoding('*;q=0, gzip'), { ext: '.gz', name: 'gzip' });
});

test('pickEncoding matches whole tokens, not substrings', () => {
  assert.equal(pickEncoding('xbr'), null);
  assert.equal(pickEncoding('gzipx'), null);
});

test('HASHED_BUNDLE gates hashed js/css bundles, not maps or plain files', () => {
  assert.ok(HASHED_BUNDLE.test('/public/controller/controller.ca7760414e.js'));
  assert.ok(HASHED_BUNDLE.test('/public/display/display.684e65cd4b.js'));
  // Hashed CSS bundles carry the same .br/.gz siblings, so they negotiate too.
  assert.ok(HASHED_BUNDLE.test('/public/controller/controller.ca7760414e.css'));
  assert.ok(HASHED_BUNDLE.test('/public/display/display.684e65cd4b.css'));
  // The .map sidecar is immutable but never negotiated (no sibling emitted).
  assert.ok(!HASHED_BUNDLE.test('/public/controller/controller.ca7760414e.js.map'));
  // Un-hashed source files (dev mode, engine route) are excluded.
  assert.ok(!HASHED_BUNDLE.test('/public/controller/controller.js'));
  assert.ok(!HASHED_BUNDLE.test('/public/shared/theme.css'));
  assert.ok(!HASHED_BUNDLE.test('/server/Game.js'));
});
