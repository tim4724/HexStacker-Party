#!/usr/bin/env node
'use strict';

// Assembles site/, the static files every deployed host serves through Apache
// with public/.htaccess. `npm run build:site` runs `npm run build` first.
//
// site/ is public/ minus the build inputs, with the pages rendered. Also left
// out: the .br/.gz siblings (Apache compresses on the fly) and the review
// galleries (served by their own pod on previews).
//
// The version label is baked into the pages here: APP_ENV=production shows the
// bare version, anything else appends the commit from GIT_SHA.

const fs = require('fs');
const path = require('path');
const { ROOT, CONTROLLER_STYLES, DISPLAY_STYLES, PRERENDERED_PAGES } = require('./asset-manifest.js');
const { renderShell, bundleSubs } = require('./render-shell.js');

const PUBLIC = path.join(ROOT, 'public');
const OUT = path.join(ROOT, 'site');
const HASHED = /\.[0-9a-f]{10}\.(js|css)(\.map)?$/;

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist', 'web-manifest.json'), 'utf8'));
const version = require('../package.json').version;
const sha = String(process.env.GIT_SHA || '').trim().slice(0, 7);
const versionLabel = version + (process.env.APP_ENV !== 'production' && sha ? ' (#' + sha + ')' : '');

// Paths relative to public/, as the pages reference them.
const pages = new Set(PRERENDERED_PAGES.map((u) => u.slice(1)));
const bundledStyles = new Set([].concat(CONTROLLER_STYLES, DISPLAY_STYLES).map((u) => u.slice(1)));
const bundles = new Set();
for (const [app, files] of Object.entries(manifest)) {
  const dir = app.startsWith('controller') ? 'controller' : 'display';
  bundles.add(dir + '/' + files.js);
  bundles.add(dir + '/' + files.js + '.map');
  if (files.css) bundles.add(dir + '/' + files.css);
}

function shipped(rel) {
  const name = path.basename(rel);
  if (name === '.DS_Store' || rel.startsWith('gallery') || /\.(br|gz)$/.test(name)) return false;
  if (HASHED.test(name)) return bundles.has(rel);
  if (name.endsWith('.js')) return false;
  return !bundledStyles.has(rel);
}

fs.rmSync(OUT, { recursive: true, force: true });

(function copy(dir) {
  for (const entry of fs.readdirSync(path.join(PUBLIC, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) { copy(rel); continue; }
    if (pages.has(rel) || !shipped(rel)) continue;
    fs.mkdirSync(path.join(OUT, dir), { recursive: true });
    fs.copyFileSync(path.join(PUBLIC, rel), path.join(OUT, rel));
  }
})('');

const subs = Object.assign({ versionLabel: versionLabel, appVersion: version }, bundleSubs(manifest));
for (const rel of pages) {
  fs.mkdirSync(path.dirname(path.join(OUT, rel)), { recursive: true });
  fs.writeFileSync(path.join(OUT, rel), renderShell(fs.readFileSync(path.join(PUBLIC, rel), 'utf8'), subs));
}

console.log('build-site: site/ (' + versionLabel + ')');
