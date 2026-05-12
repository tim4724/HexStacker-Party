#!/usr/bin/env node
'use strict';

/**
 * Generate AirConsole HTML entry points from the canonical index.html files.
 *
 * Transforms:
 *  - Adds class="airconsole" to <body>
 *  - Strips meta/link tags useless inside an iframe (OG/Twitter, theme-color,
 *    PWA-install hints, favicon links)
 *  - Strips the controller name-screen legal-links footer (name screen is
 *    bypassed in AC mode; the anchors point to /privacy and /imprint which
 *    aren't part of the AC zip)
 *  - Strips test harness <script> tags (gallery / Playwright only — gated
 *    on URL params the AC iframe never has)
 *  - Strips share-helper.js (the only caller is the device-choice share
 *    banner, and device-choice is CSS-hidden in AC mode)
 *  - Strips the <picture> element inside the device-choice overlay (the
 *    /artwork/* sources aren't bundled into the AC zip; without this the
 *    browser would still fetch them and 404, even though the overlay is
 *    CSS-hidden)
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
const SDK_VERSION = getArg('--sdk-version') || '1.11.0';
const SDK_TAG = `  <script src="https://www.airconsole.com/api/airconsole-${SDK_VERSION}.js"></script>\n`;

// ---------------------------------------------------------------------------
// Shared transforms
// ---------------------------------------------------------------------------

function transform(html, { bootstrapScript }) {
  // 1. Add class="airconsole" to <body>
  html = html.replace('<body>', '<body class="airconsole">');

  // 2. Strip iframe-irrelevant <meta> and <link> tags. Cross-origin iframes
  // can't surface theme-color or PWA-install hints to the host browser, OG /
  // Twitter cards are never crawled, favicons belong to the top document.
  html = html.replace(/^\s*<meta\s+(property="og:|name="twitter:|name="description"|name="theme-color"|name="apple-mobile-web-app-capable"|name="mobile-web-app-capable")[^>]*>\n/gm, '');
  html = html.replace(/^\s*<link\s+rel="icon"[^>]*>\n/gm, '');

  // 3. Strip the controller name-screen legal-links footer (dead DOM in AC).
  html = html.replace(/^\s*<div class="legal-links">[\s\S]*?<\/div>\n/m, '');

  // 4. Strip test harness <script> tags — gallery / Playwright only.
  html = html.replace(/^\s*<script src="[^"]*TestHarness\.js"><\/script>\n/gm, '');

  // 5. Drop share-helper.js. Only the display's device-choice share
  // banner calls HexStacker.share, and device-choice is CSS-hidden in AC.
  html = html.replace(/^\s*<script src="[^"]*share-helper\.js"><\/script>\n/m, '');

  // 6. Drop PartyConnection.js and PartyFastlane.js. The AC bootstrap
  // reassigns the global `PartyConnection` to an AirConsoleAdapter factory
  // before any caller uses it, and the fastlane is explicitly gated by
  // `!window.airconsole` at both call sites — so both files are dead code
  // in AC mode (~26 KB raw).
  html = html.replace(/^\s*<script src="[^"]*Party(Connection|Fastlane)\.js"><\/script>\n/gm, '');

  // 7. Strip <picture> inside the device-choice overlay. The /artwork/*
  // sources aren't bundled into the AC zip; without this the browser
  // would still resolve and fetch them (returning 404) even though the
  // overlay itself is CSS-hidden in AC.
  html = html.replace(/^\s*<picture>[\s\S]*?<\/picture>\n/m, '');

  // 8. Convert absolute paths to relative in src/href attributes
  html = html.replace(/(src|href)="\/(?!\/)/g, '$1="');

  // 9. Inject AirConsole SDK before first engine script
  html = html.replace(
    /^(\s*<script src="engine\/)/m,
    `${SDK_TAG}\n$1`
  );

  // 10. Inject bootstrap script before the entry-point script
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
