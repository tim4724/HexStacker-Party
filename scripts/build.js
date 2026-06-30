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
const esbuild = require('esbuild');
const { ROOT, CONTROLLER_SCRIPTS, DISPLAY_SCRIPTS, resolveAsset } = require('./asset-manifest.js');

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
  });
  const hash = crypto.createHash('sha256').update(result.code).digest('hex').slice(0, 10);
  const file = name + '.' + hash + '.js';
  // Bundles live beside their source dir so the existing /controller/, /display/
  // static routes serve them with no new route.
  fs.writeFileSync(path.join(ROOT, 'public', name, file), result.code);
  return file;
}

async function main() {
  await buildCore();
  console.log('build: dist/partycore.js');

  const manifest = {
    controller: await buildApp('controller', CONTROLLER_SCRIPTS),
    display: await buildApp('display', DISPLAY_SCRIPTS),
  };
  fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'dist', 'web-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log('build: public/controller/' + manifest.controller);
  console.log('build: public/display/' + manifest.display);
}

if (require.main === module) {
  main().catch(function (err) { console.error(err); process.exit(1); });
}

module.exports = { ROOT: ROOT, coreOptions: coreOptions, buildCore: buildCore };
