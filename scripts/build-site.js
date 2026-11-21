#!/usr/bin/env node
'use strict';

// Assembles site/, the static files every deployed host serves through Apache
// with public/.htaccess. `npm run build:site` runs `npm run build` first.
//
// site/ is public/ minus the build inputs, with the pages rendered. Every build
// but production keeps the review galleries (main serves them; on previews
// their pod does, and the app serves the files they load, which
// scripts/gallery/stage-assets.mjs adds after this).
//
// The version label is baked into the pages here: APP_ENV=production shows the
// bare version, anything else appends the commit from GIT_SHA.

const fs = require('fs');
const path = require('path');
const { ROOT, CONTROLLER_STYLES, DISPLAY_STYLES } = require('./asset-manifest.js');
const { renderShell, bundleSubs } = require('./render-shell.js');

const PUBLIC = path.join(ROOT, 'public');
const OUT = path.join(ROOT, 'site');
const HASHED = /\.[0-9a-f]{10}\.(js|css)(\.map)?$/;

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist', 'web-manifest.json'), 'utf8'));
const version = require('../package.json').version;
const sha = String(process.env.GIT_SHA || '').trim().slice(0, 7);
const production = process.env.APP_ENV === 'production';
const versionLabel = version + (!production && sha ? ' (#' + sha + ')' : '');

// Paths relative to public/, as the pages reference them.
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
  if (name === '.DS_Store') return false;
  if (rel.startsWith('gallery')) return !production;
  if (HASHED.test(name)) return bundles.has(rel);
  if (name.endsWith('.js')) return false;
  return !bundledStyles.has(rel);
}

const subs = Object.assign({ versionLabel: versionLabel, appVersion: version }, bundleSubs(manifest));

fs.rmSync(OUT, { recursive: true, force: true });

(function copy(dir) {
  for (const entry of fs.readdirSync(path.join(PUBLIC, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) { copy(rel); continue; }
    if (!shipped(rel)) continue;
    fs.mkdirSync(path.join(OUT, dir), { recursive: true });
    if (rel.endsWith('.html')) {
      fs.writeFileSync(path.join(OUT, rel), renderShell(fs.readFileSync(path.join(PUBLIC, rel), 'utf8'), subs));
    } else {
      fs.copyFileSync(path.join(PUBLIC, rel), path.join(OUT, rel));
    }
  }
})('');

console.log('build-site: site/ (' + versionLabel + ')');
