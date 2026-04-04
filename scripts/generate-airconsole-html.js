#!/usr/bin/env node
'use strict';

/**
 * Generate AirConsole HTML entry points from the canonical index.html files.
 *
 * Transforms:
 *  - Adds class="airconsole" to <body>
 *  - Strips OG / Twitter meta tags (useless inside an iframe)
 *  - Converts absolute paths ("/shared/...") to relative ("shared/...")
 *  - Injects AirConsole SDK <script> before first engine script
 *  - Injects bootstrap script before the entry-point script
 *
 * Usage:
 *   node scripts/generate-airconsole-html.js [--sdk-version 1.10.0]
 */

const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'public');
const SDK_VERSION = getArg('--sdk-version') || '1.10.0';
const SDK_TAG = `  <script src="https://www.airconsole.com/api/airconsole-${SDK_VERSION}.js"></script>\n`;

// ---------------------------------------------------------------------------
// Shared transforms
// ---------------------------------------------------------------------------

function transform(html, { bootstrapScript }) {
  // 1. Add class="airconsole" to <body>
  html = html.replace('<body>', '<body class="airconsole">');

  // 2. Strip OG / Twitter / description meta tags
  html = html.replace(/^\s*<meta\s+(property="og:|name="twitter:|name="description")[^>]*>\n/gm, '');

  // 3. Convert absolute paths to relative in src/href attributes
  html = html.replace(/(src|href)="\/(?!\/)/g, '$1="');

  // 4. Inject AirConsole SDK before first engine script
  html = html.replace(
    /^(\s*<script src="engine\/)/m,
    `${SDK_TAG}\n$1`
  );

  // 5. Inject bootstrap script before the entry-point script
  const entryFile = path.basename(bootstrapScript).replace('-airconsole', '');
  html = html.replace(
    new RegExp(`^(\\s*<script src="[^"]*${entryFile}"></script>)`, 'm'),
    `  <script src="${bootstrapScript}"></script>\n$1`
  );

  return html;
}

// ---------------------------------------------------------------------------
// Generate
// ---------------------------------------------------------------------------

// Display: index.html → screen.html
const displaySrc = fs.readFileSync(path.join(PUBLIC, 'display', 'index.html'), 'utf8');
const screenHtml = transform(displaySrc, {
  bootstrapScript: 'display/display-airconsole.js',
});
fs.writeFileSync(path.join(PUBLIC, 'display', 'screen.html'), screenHtml);

// Controller: index.html → controller.html
const ctrlSrc = fs.readFileSync(path.join(PUBLIC, 'controller', 'index.html'), 'utf8');
const ctrlHtml = transform(ctrlSrc, {
  bootstrapScript: 'controller/controller-airconsole.js',
});
fs.writeFileSync(path.join(PUBLIC, 'controller', 'controller.html'), ctrlHtml);

console.log('Generated display/screen.html and controller/controller.html (SDK %s)', SDK_VERSION);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getArg(name) {
  const idx = process.argv.indexOf(name);
  return idx !== -1 ? process.argv[idx + 1] : null;
}
