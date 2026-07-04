#!/usr/bin/env node
'use strict';

// Renders the layered tvOS App Icon (small + App Store) from the HexStacker
// brand primitives (artwork/tvos-icon.html) and writes them into the tvOS asset
// catalog. Per the tvOS HIG the icon is a single centered focal point with no
// text (the shelf shows the app name itself): the "piece badge" — the game's
// 'd' piece in the party colorway as in-game pillow cells — floating over a
// flat brand plum. Two parallax layers: BACK (opaque plum + the badge's soft
// drop shadow), FRONT (the badge on transparency), so the focus wobble makes
// the piece hover above its own shadow. Badge is bounding-box centered at
// sizeFrac 0.20 — inside the 370x222 safe zone (of 400x240) and legible at the
// 300x180 unfocused size. The gallery-artwork page reviews the assembled look
// by compositing these two shipped layers live in CSS (no baked preview PNGs).
//
//   node artwork/generate-tvos-icons.js
//
// The Top Shelf (the fullscreen showcase) is the gameplay key art, generated
// separately by generate-tvos-topshelf.js — Apple's HIG wants rich key art
// there and a simple logo for the icon.

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const PAGE = path.resolve(__dirname, 'tvos-icon.html');
const XC = path.resolve(ROOT,
  'appletv/Sources/HexStackerTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets');

const ICON = {
  bg: '#241E38',
  badge: { nx: 0.5, ny: 0.5, sizeFrac: 0.20 },
};

function iconSpec(layer, w, h) {
  return { w, h, layer, ...ICON };
}

// ---- Asset manifest: [destAbsPath, spec] --------------------------------
const ICONSTACK = path.join(XC, 'App Icon.imagestack');
const APPSTORE = path.join(XC, 'App Icon - App Store.imagestack');

const ASSETS = [
  // small App Icon — layered
  [path.join(ICONSTACK, 'Back.imagestacklayer/Content.imageset/back-400x240.png'),   iconSpec('back', 400, 240)],
  [path.join(ICONSTACK, 'Back.imagestacklayer/Content.imageset/back-800x480.png'),   iconSpec('back', 800, 480)],
  [path.join(ICONSTACK, 'Front.imagestacklayer/Content.imageset/front-400x240.png'), iconSpec('front', 400, 240)],
  [path.join(ICONSTACK, 'Front.imagestacklayer/Content.imageset/front-800x480.png'), iconSpec('front', 800, 480)],
  // App Store icon — layered, single scale
  [path.join(APPSTORE, 'Back.imagestacklayer/Content.imageset/appstore-back-1280x768.png'),   iconSpec('back', 1280, 768)],
  [path.join(APPSTORE, 'Front.imagestacklayer/Content.imageset/appstore-front-1280x768.png'), iconSpec('front', 1280, 768)],
];

async function writeDataUrl(dataUrl, dest) {
  const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(b64, 'base64'));
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`file://${PAGE}`);
  await page.waitForFunction(() => window.__TVOS_READY__ === true);

  const render = (spec) => page.evaluate((s) => window.renderHexBrandLayer(s), spec);

  for (const [dest, spec] of ASSETS) {
    await writeDataUrl(await render(spec), dest);
    console.log('asset  ', path.relative(ROOT, dest));
  }

  await browser.close();
  console.log('\nDone.');
})().catch((e) => { console.error(e); process.exit(1); });
