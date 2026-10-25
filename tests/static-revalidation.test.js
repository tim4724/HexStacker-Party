'use strict';

// The un-hashed static assets (fonts, font CSS, icons, the hero image) are
// cached for a day in production. They carry a size+mtime ETag so a visit after
// expiry revalidates with a 304 instead of re-downloading, and the small text
// ones (font CSS, SVG marks, favicon) are compressed in memory. Production mode
// is read at module load, so this boots the real server as a child process.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const zlib = require('node:zlib');
const { etagMatches } = require('../server/index.js');

const PUBLIC = path.join(__dirname, '..', 'public');
let child;
let base;

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

before(async () => {
  const port = await freePort();
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, APP_ENV: 'production', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    child.on('exit', (code) => reject(new Error('server exited ' + code)));
    child.stdout.on('data', (d) => { if (/running on/.test(String(d))) resolve(); });
  });
  base = `http://127.0.0.1:${port}`;
});

after(() => { if (child) child.kill(); });

// fetch() would transparently decode; node's http keeps the raw bytes.
function get(urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    require('node:http').get(base + urlPath, { headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

test('etagMatches uses weak comparison over a list, and *', () => {
  assert.ok(etagMatches('W/"a-b"', 'W/"a-b"'));
  assert.ok(etagMatches('"a-b"', 'W/"a-b"'));
  assert.ok(etagMatches('"x", W/"a-b"', 'W/"a-b"'));
  assert.ok(etagMatches('*', 'W/"a-b"'));
  assert.ok(!etagMatches('W/"a-c"', 'W/"a-b"'));
  assert.ok(!etagMatches('', 'W/"a-b"'));
  assert.ok(!etagMatches(undefined, 'W/"a-b"'));
});

test('font CSS is brotli-compressed with a validator and revalidates to 304', async () => {
  const src = fs.readFileSync(path.join(PUBLIC, 'shared/fonts/baloo2.css'));
  const res = await get('/shared/fonts/baloo2.css', { 'accept-encoding': 'br, gzip' });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-encoding'], 'br');
  assert.equal(res.headers['vary'], 'Accept-Encoding');
  assert.equal(res.headers['cache-control'], 'public, max-age=86400');
  assert.match(res.headers['etag'], /^W\/"[0-9a-z]+-[0-9a-z]+"$/);
  assert.ok(res.body.length < src.length);
  assert.deepEqual(zlib.brotliDecompressSync(res.body), src);

  const again = await get('/shared/fonts/baloo2.css', { 'accept-encoding': 'br', 'if-none-match': res.headers['etag'] });
  assert.equal(again.status, 304);
  assert.equal(again.body.length, 0);
  assert.equal(again.headers['etag'], res.headers['etag']);
  assert.equal(again.headers['cache-control'], 'public, max-age=86400');
});

test('compressed assets honor gzip-only and identity clients', async () => {
  const src = fs.readFileSync(path.join(PUBLIC, 'favicon.ico'));
  const gz = await get('/favicon.ico', { 'accept-encoding': 'gzip' });
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.deepEqual(zlib.gunzipSync(gz.body), src);
  const plain = await get('/favicon.ico');
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(plain.headers['vary'], 'Accept-Encoding');
  assert.deepEqual(plain.body, src);
});

test('binary and tiny assets get a validator but no encoding', async () => {
  const font = await get('/shared/fonts/Orbitron.woff2', { 'accept-encoding': 'br' });
  assert.equal(font.status, 200);
  assert.ok(font.headers['etag']);
  assert.equal(font.headers['content-encoding'], undefined);
  assert.equal(font.headers['vary'], undefined);
  assert.equal((await get('/shared/fonts/Orbitron.woff2', { 'if-none-match': font.headers['etag'] })).status, 304);

  // Below MIN_COMPRESS_BYTES: not worth a Vary split.
  const tiny = await get('/shared/fonts/orbitron.css', { 'accept-encoding': 'br' });
  assert.equal(tiny.headers['content-encoding'], undefined);
  assert.equal(tiny.headers['vary'], undefined);
});

test('no-store responses never carry a validator', async () => {
  const page = await get('/', { 'accept-encoding': 'br' });
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.equal(page.headers['etag'], undefined);
  assert.equal((await get('/nope.css')).status, 404);
});
