#!/usr/bin/env node
'use strict';

// Pre-render every prod-served HTML page (PRERENDERED_PAGES, asset-manifest.js) to its
// final bytes and pre-compress it, so server/index.js serves static, negotiated
// br/gz artifacts with zero per-request templating or compression.
//
// Runs LAST in the web build (`npm run build`): it consumes scripts/build.js's
// bundle manifest and generate-airconsole-html.js's AC entries, so both must
// have run first. Each page is deterministic here in prod — the shells expand to
// hashed bundle tags, and the legal/AC pages differ from source only by the
// version string (APP_VERSION, no dev " (#sha)" suffix). renderShell is shared
// with the server's dev-time rewrite so the two renderings can't drift; the
// server keeps that runtime path only for dev (live files, unbundled tags, sha).

const fs = require('fs');
const path = require('path');
const { ROOT, resolveAsset, PRERENDERED_PAGES, distName } = require('./asset-manifest.js');
const { renderShell } = require('./render-shell.js');
const { writeCompressed } = require('./write-compressed.js');

const APP_VERSION = require('../package.json').version;
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist', 'web-manifest.json'), 'utf8'));

// One prod substitution set for every page. The script/style tag values simply
// don't match on the legal + AC pages (which carry only version placeholders),
// so the same subs render both the shells and those correctly.
const subs = {
  versionLabel: APP_VERSION,
  appVersion: APP_VERSION,
  controllerScripts: '<script src="/controller/' + manifest.controller.js + '"></script>',
  displayScripts: '<script src="/display/' + manifest.display.js + '"></script>',
  controllerStyles: '<link rel="stylesheet" href="/controller/' + manifest.controller.css + '">',
  displayStyles: '<link rel="stylesheet" href="/display/' + manifest.display.css + '">',
};

for (const url of PRERENDERED_PAGES) {
  const raw = fs.readFileSync(resolveAsset(url), 'utf8');
  writeCompressed(path.join(ROOT, 'dist', distName(url)), Buffer.from(renderShell(raw, subs)));
}
console.log('build: ' + PRERENDERED_PAGES.length + ' HTML pages -> dist/ (pre-rendered, pre-compressed)');
