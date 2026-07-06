#!/usr/bin/env node
'use strict';

// Build step (esbuild). Currently bundles the portable native core; the web
// controller/display app bundles are added here as those shells are modularized.
//
// Run directly (`npm run build`) to write artifacts to disk. The build options
// are also required() by tests so the runtime gate bundles with the exact same
// config the artifact ships with, and can't drift.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const zlib = require('zlib');
const esbuild = require('esbuild');
const { ROOT, CONTROLLER_SCRIPTS, DISPLAY_SCRIPTS, CONTROLLER_STYLES, DISPLAY_STYLES, resolveAsset } = require('./asset-manifest.js');
const { writeCompressed } = require('./write-compressed.js');

// Portable native core: server/core-entry.js -> dist/partycore.js as an iife
// exposing globalThis.HexCore. platform:'neutral' so esbuild assumes neither
// Node nor browser globals (the target is a bare JS engine); target es2017 keeps
// the output within JavaScriptCore (tvOS) / QuickJS (Android TV) support.
function coreOptions(extra) {
  return Object.assign({
    entryPoints: [path.join(ROOT, 'server', 'core-entry.js')],
    bundle: true,
    format: 'iife',
    globalName: 'HexCore',
    platform: 'neutral',
    target: 'es2017',
    legalComments: 'none',
  }, extra || {});
}

async function buildCore() {
  await esbuild.build(coreOptions({
    outfile: path.join(ROOT, 'dist', 'partycore.js'),
    sourcemap: true,
  }));
}

// The i18n keys the native displays (tvOS / Android TV) actually render. The web
// controller-, legal-, and settings-only keys are excluded so the shipped table
// stays small. Kept here (not in the native ports) so the single source of truth
// for copy remains public/shared/i18n.js — the ports load the generated JSON and
// can never drift from the web wording.
const LOCALE_DISPLAY_KEYS = [
  // In-game HUD + board overlays
  'hold', 'next', 'level', 'lines', 'ko', 'go', 'triple', 'double',
  'scan_to_rejoin', 'disconnected',
  // Lobby
  'scan_to_join', 'waiting_for_players', 'start_n_players', 'level_heading',
  'music_by',
  // Pause overlay
  'paused', 'continue_btn', 'new_game', 'settings_game_music',
  // Display-connection overlay
  'reconnecting', 'connection_lost', 'reconnect', 'attempt_n_of_m',
  // Results
  'play_again', 'n_lines', 'level_n', 'new_player', 'player',
  // About screen legal links (Privacy / Imprint QR labels)
  'privacy', 'imprint',
];

// Emit dist/locale.json: the display key subset of every locale in i18n.js. The
// native ports bundle this next to the engine (sync-engine.sh) and resolve it at
// runtime, so the TV copy is generated from the same source as the web and never
// hand-maintained. Plural keys keep their { one, other, ... } object shape.
function buildLocale() {
  const { LOCALES } = require('../public/shared/i18n.js');
  const out = {};
  for (const lang of Object.keys(LOCALES)) {
    const strings = LOCALES[lang];
    const subset = {};
    for (const key of LOCALE_DISPLAY_KEYS) {
      if (strings[key] !== undefined) subset[key] = strings[key];
    }
    out[lang] = subset;
  }
  fs.writeFileSync(path.join(ROOT, 'dist', 'locale.json'), JSON.stringify(out) + '\n');
}

// Web app bundle: concatenate the app's scripts in load order, then run the
// result through esbuild.transform (whitespace + syntax minify only). Identifier
// minification is OFF on purpose: the shells are global-scope scripts whose
// names are reached from OUTSIDE the bundle (the separately-loaded test harness,
// inline HTML handlers, the AirConsole bootstrap, and cross-file references),
// and transform (vs build) keeps everything at top-level script scope so those
// globals survive. Output is content-hashed so it can be cached immutably.
async function buildApp(name, scripts) {
  let source = '';
  for (const urlPath of scripts) {
    source += '// ==== ' + urlPath + ' ====\n'
      + fs.readFileSync(resolveAsset(urlPath), 'utf8') + '\n';
  }
  const result = await esbuild.transform(source, {
    minifyWhitespace: true,
    minifySyntax: true,
    minifyIdentifiers: false,
    target: 'es2017',
    legalComments: 'none',
    sourcemap: 'external',
    sourcefile: name + '.bundle.src.js',
  });
  // Hash the code only (NOT the trailing sourceMappingURL, which references the
  // hash — that would be circular). The .map sits beside the bundle so a prod
  // stack trace resolves into source instead of minified output; the server
  // serves both immutably (content-hashed names).
  const hash = crypto.createHash('sha256').update(result.code).digest('hex').slice(0, 10);
  const file = name + '.' + hash + '.js';
  // Bundles live beside their source dir so the existing /controller/, /display/
  // static routes serve them with no new route.
  const dir = path.join(ROOT, 'public', name);
  // Sweep stale content-hashed bundles (+ .map) so repeated local builds don't
  // leave orphans behind. The un-prefixed regex matches both `<name>.<hash>.js`
  // and its `.map`; the source files `<name>.js` lack the hash segment and are
  // untouched. (CI/Docker start from a clean tree, so this only matters locally.)
  const stale = new RegExp('^' + name + '\\.[0-9a-f]{10}\\.js');
  for (const f of fs.readdirSync(dir)) {
    if (stale.test(f)) fs.rmSync(path.join(dir, f));
  }
  const js = result.code + '\n//# sourceMappingURL=' + file + '.map\n';
  const jsPath = path.join(dir, file);
  fs.writeFileSync(jsPath, js);
  fs.writeFileSync(jsPath + '.map', result.map);
  // Pre-compressed siblings for the immutable bundle. server/index.js negotiates
  // these via Accept-Encoding, so a browser downloads ~1/4 the bytes with zero
  // per-request CPU. This is a build-time one-shot on a content-hashed artifact,
  // so we spend max effort (brotli 11 / gzip 9). Only the .js is compressed — the
  // .map is a rare, devtools-only fetch. The stale-sweep regex above already
  // matches these (they share the `<name>.<hash>.js` prefix), so old ones are
  // cleaned on rebuild alongside the .js/.map.
  const jsBuf = Buffer.from(js);
  fs.writeFileSync(jsPath + '.br', zlib.brotliCompressSync(jsBuf, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: jsBuf.length,
    },
  }));
  fs.writeFileSync(jsPath + '.gz', zlib.gzipSync(jsBuf, { level: 9 }));
  return file;
}

// Web CSS bundle: concatenate the app's stylesheets in cascade order, minify
// (esbuild's css loader), content-hash, and emit `.br`/`.gz` siblings — the
// exact treatment buildApp() gives the JS, and for the same reasons. CSS is
// render-blocking and, unlike the JS, ships uncompressed from this server today
// (only hashed bundles are Accept-Encoding-negotiated), so bundling both cuts
// the request count and finally compresses it. No sourcemap: concatenated,
// minified CSS has little debugging value and the map would be a rare fetch.
async function buildStyles(name, styles) {
  let source = '';
  for (const urlPath of styles) {
    source += '/* ==== ' + urlPath + ' ==== */\n'
      + fs.readFileSync(resolveAsset(urlPath), 'utf8') + '\n';
  }
  const result = await esbuild.transform(source, {
    loader: 'css',
    minify: true,
    legalComments: 'none',
  });
  const hash = crypto.createHash('sha256').update(result.code).digest('hex').slice(0, 10);
  const file = name + '.' + hash + '.css';
  const dir = path.join(ROOT, 'public', name);
  // Sweep stale hashed CSS bundles (+ their .br/.gz) so local rebuilds don't
  // orphan them. Prefix match (no `$`) also catches the compressed siblings;
  // the un-hashed source `<name>.css` lacks the hash segment and is untouched.
  const stale = new RegExp('^' + name + '\\.[0-9a-f]{10}\\.css');
  for (const f of fs.readdirSync(dir)) {
    if (stale.test(f)) fs.rmSync(path.join(dir, f));
  }
  writeCompressed(path.join(dir, file), Buffer.from(result.code));
  return file;
}

async function main() {
  fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });

  await buildCore();
  console.log('build: dist/partycore.js');
  buildLocale();
  console.log('build: dist/locale.json');

  // `--core` (npm run build:core): the native ports need only the portable core
  // bundle (+ the locale table). Stop here so the tvOS pre-build phase / swift
  // tests don't also sweep and rewrite the git-ignored public/ hashed web bundles.
  if (process.argv.includes('--core')) return;

  // Independent (different output dirs/files, no shared state), so build the JS
  // and CSS bundles for both apps concurrently — `npm start` runs this on boot.
  const [controller, display, controllerCss, displayCss] = await Promise.all([
    buildApp('controller', CONTROLLER_SCRIPTS),
    buildApp('display', DISPLAY_SCRIPTS),
    buildStyles('controller', CONTROLLER_STYLES),
    buildStyles('display', DISPLAY_STYLES),
  ]);
  const manifest = {
    controller: { js: controller, css: controllerCss },
    display: { js: display, css: displayCss },
  };
  fs.writeFileSync(path.join(ROOT, 'dist', 'web-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log('build: public/controller/' + manifest.controller.js + ' + ' + manifest.controller.css);
  console.log('build: public/display/' + manifest.display.js + ' + ' + manifest.display.css);
  // The prod HTML pages are rendered + cached at server boot (server/index.js
  // HTML_CACHE), not here — the version label they carry is per-deployment and
  // only known at runtime.
}

if (require.main === module) {
  main().catch(function (err) { console.error(err); process.exit(1); });
}

// Only coreOptions is part of the surface (tests/core-bundle-runtime.test.js
// bundles the core with the exact shipped config). The build steps run via the
// CLI entry above.
module.exports = { coreOptions: coreOptions };
