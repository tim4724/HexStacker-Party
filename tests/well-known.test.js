'use strict';

// Pins the app-link endpoints served inline by server/index.js. A regression
// here (route lost, wrong content-type, malformed JSON) breaks iOS Universal
// Links / Android App Links verification with no visible symptom in the web
// app, so assert the invariants Apple's CDN and Android's verifier check:
// HTTP 200, application/json, and the structural essentials of each payload.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { server } = require('../server/index.js');

let baseUrl;

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

test('apple-app-site-association is JSON with the room-code applink', async () => {
  const res = await fetch(`${baseUrl}/.well-known/apple-app-site-association`);
  assert.equal(res.status, 200);
  // Apple's CDN requires application/json; the extensionless path would fall
  // back to octet-stream if this ever slipped into the generic static route.
  assert.equal(res.headers.get('content-type'), 'application/json');
  const aasa = await res.json();
  const detail = aasa.applinks.details[0];
  assert.ok(detail.appIDs.length > 0);
  assert.ok(detail.appIDs.every((id) => /^\w{10}\..+/.test(id)));
  // Exactly one path component: the 6-char room code.
  assert.deepEqual(detail.components.map((c) => c['/']), ['/??????']);
});

test('assetlinks.json is JSON with a handle_all_urls statement', async () => {
  const res = await fetch(`${baseUrl}/.well-known/assetlinks.json`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/json');
  const statements = await res.json();
  assert.ok(Array.isArray(statements) && statements.length > 0);
  for (const s of statements) {
    assert.deepEqual(s.relation, ['delegate_permission/common.handle_all_urls']);
    assert.equal(s.target.namespace, 'android_app');
    assert.ok(s.target.package_name);
    assert.ok(s.target.sha256_cert_fingerprints.length > 0);
    for (const fp of s.target.sha256_cert_fingerprints) {
      assert.match(fp, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    }
  }
});
