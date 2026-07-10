#!/usr/bin/env node
'use strict';

// Finalize the AirConsole ZIP's HTML entry points. The generated
// public/display/screen.html and public/controller/controller.html carry the
// AC script/style markers (see generate-airconsole-html.js); the web server
// expands those at serve time, but the zip is static — so this expands them at
// build time instead: one RELATIVE <script>/<link> tag per app pointing at the
// content-hashed bundles from dist/web-manifest.json, plus the baked version
// (release artifact, so no dev "(#sha)" suffix). renderShell is the same
// expansion the server uses, so the two paths can't drift.
//
// Usage: node scripts/finalize-airconsole-html.js <buildDir>

const fs = require('fs');
const path = require('path');
const { renderShell } = require('./render-shell.js');

const ROOT = path.join(__dirname, '..');
const buildDir = process.argv[2];
if (!buildDir) {
  console.error('usage: finalize-airconsole-html.js <buildDir>');
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist', 'web-manifest.json'), 'utf8'));
const version = require(path.join(ROOT, 'package.json')).version;

function scriptTag(dir, file) {
  return '<script src="' + dir + '/' + file + '"></script>';
}
function styleTag(dir, file) {
  return '<link rel="stylesheet" href="' + dir + '/' + file + '">';
}

const subs = {
  versionLabel: version,
  appVersion: version,
  // The web *_SCRIPTS markers never appear in the AC HTML (the generator
  // replaced them); empty strings keep any regression loud in the output.
  controllerScripts: '',
  displayScripts: '',
  acControllerScripts: scriptTag('controller', manifest['controller-ac'].js),
  acDisplayScripts: scriptTag('display', manifest['display-ac'].js),
  controllerStyles: styleTag('controller', manifest.controller.css),
  displayStyles: styleTag('display', manifest.display.css),
};

for (const [src, out] of [
  [path.join(ROOT, 'public', 'display', 'screen.html'), path.join(buildDir, 'screen.html')],
  [path.join(ROOT, 'public', 'controller', 'controller.html'), path.join(buildDir, 'controller.html')],
]) {
  fs.writeFileSync(out, renderShell(fs.readFileSync(src, 'utf8'), subs));
}
console.log('finalize-airconsole-html: wrote screen.html + controller.html (v' + version + ')');
