#!/usr/bin/env node
'use strict';

// Renders the layered tvOS App Icon (small + App Store) from the HexStacker
// brand primitives (artwork/tvos-icon.html) and writes them into the tvOS asset
// catalog. Layered icons get a transparent FRONT (pieces + wordmark) over a
// full-bleed BACK (plum gradient + soft depth pieces) for the parallax effect;
// uses canvas.toDataURL so the front layer keeps real alpha. The Top Shelf
// (the fullscreen showcase) is the gameplay key art, generated separately by
// generate-tvos-topshelf.js — Apple's HIG wants rich key art there and a simple
// logo for the icon, so the two assets are produced by different scripts.
//
//   node artwork/generate-tvos-icons.js          # write assets + previews
//   node artwork/generate-tvos-icons.js --preview-only
//
// Layouts are normalized (nx/ny in 0..1; sizeFrac = hex circumradius / height)
// so one layout renders at every scale of the icon.

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const PAGE = path.resolve(__dirname, 'tvos-icon.html');
const XC = path.resolve(ROOT,
  'appletv/Sources/HexStackerTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets');
const PREVIEW_DIR = path.resolve(__dirname, 'tvos-preview');

const PREVIEW_ONLY = process.argv.includes('--preview-only');

// ---- Layouts -------------------------------------------------------------
// ICON family (5:3) — small App Icon + App Store icon. Hero 2-line wordmark,
// colorful pieces framing the corners, soft blurred pieces behind for depth.
// Mirrors the official brand lockup (public/artwork/social-preview.png): the
// 1-line "HEX STACKER" gradient wordmark + letter-spaced "PARTY", with colorful
// hex clusters scattered top + bottom (top ones with falling-piece trails) on
// the plum radial. Clusters sit inboard of the corners so the tvOS rounded-rect
// mask + parallax zoom never crops a cluster mid-shape.
const ICON = {
  aspect: '5:3',
  wordmark: {
    lines: ['HEX STACKER'], ncy: 0.455, sizeFrac: 0.155, maxWidthFrac: 0.88,
    subtitle: { text: 'PARTY', ncy: 0.63, sizeFrac: 0.07, color: '#fff3c2' },
  },
  pieces: [
    { type: 'b',  nx: 0.155, ny: 0.205, sizeFrac: 0.072, rot: 3, trailFrac: 0.30 },
    { type: 'V3', nx: 0.500, ny: 0.160, sizeFrac: 0.072, rot: 5, trailFrac: 0.30 },
    { type: 'o',  nx: 0.845, ny: 0.205, sizeFrac: 0.072, rot: 0, trailFrac: 0.30 },
    { type: 'T3', nx: 0.180, ny: 0.815, sizeFrac: 0.072, rot: 4 },
    { type: 'd',  nx: 0.500, ny: 0.855, sizeFrac: 0.072, rot: 2 },
    { type: 'I3', nx: 0.820, ny: 0.815, sizeFrac: 0.072, rot: 2 },
  ],
  backPieces: [
    { type: 'I3', nx: 0.30, ny: 0.30, sizeFrac: 0.11, rot: 0, alpha: 0.16, blurFrac: 0.06 },
    { type: 'd',  nx: 0.72, ny: 0.70, sizeFrac: 0.11, rot: 2, alpha: 0.16, blurFrac: 0.06 },
  ],
};

function iconSpec(layer, w, h) {
  return { w, h, layer, wordmark: ICON.wordmark, pieces: ICON.pieces, backPieces: ICON.backPieces };
}

// ---- Asset manifest: [destAbsPath, spec] --------------------------------
const ICONSTACK = path.join(XC, 'App Icon.imagestack');
const APPSTORE = path.join(XC, 'App Icon - App Store.imagestack');

const ASSETS = [
  // small App Icon — layered
  [path.join(ICONSTACK, 'Back.imagestacklayer/Content.imageset/back-400x240.png'),  iconSpec('back', 400, 240)],
  [path.join(ICONSTACK, 'Back.imagestacklayer/Content.imageset/back-800x480.png'),  iconSpec('back', 800, 480)],
  [path.join(ICONSTACK, 'Front.imagestacklayer/Content.imageset/front-400x240.png'), iconSpec('front', 400, 240)],
  [path.join(ICONSTACK, 'Front.imagestacklayer/Content.imageset/front-800x480.png'), iconSpec('front', 800, 480)],
  // App Store icon — layered, single scale
  [path.join(APPSTORE, 'Back.imagestacklayer/Content.imageset/appstore-back-1280x768.png'),  iconSpec('back', 1280, 768)],
  [path.join(APPSTORE, 'Front.imagestacklayer/Content.imageset/appstore-front-1280x768.png'), iconSpec('front', 1280, 768)],
];

// Flat previews (back+front flattened) for visual review.
const PREVIEWS = [
  ['icon-5x3.png',     { w: 800, h: 480, layer: 'flat', wordmark: ICON.wordmark, pieces: ICON.pieces, backPieces: ICON.backPieces }],
  ['appstore-5x3.png', { w: 1280, h: 768, layer: 'flat', wordmark: ICON.wordmark, pieces: ICON.pieces, backPieces: ICON.backPieces }],
  // front-on-checker to confirm transparency of the layered front
  ['icon-front-only.png', iconSpec('front', 800, 480)],
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
  // Make sure the weights we draw are loaded before first paint.
  await page.evaluate(async () => {
    await Promise.all([
      document.fonts.load('900 200px Orbitron'),
      document.fonts.load('700 200px Orbitron'),
    ]);
    await document.fonts.ready;
  });

  const render = (spec) => page.evaluate((s) => window.renderHexBrandLayer(s), spec);

  if (!PREVIEW_ONLY) {
    for (const [dest, spec] of ASSETS) {
      await writeDataUrl(await render(spec), dest);
      console.log('asset  ', path.relative(ROOT, dest));
    }
  }
  fs.mkdirSync(PREVIEW_DIR, { recursive: true });
  for (const [name, spec] of PREVIEWS) {
    await writeDataUrl(await render(spec), path.join(PREVIEW_DIR, name));
    console.log('preview', path.relative(ROOT, path.join(PREVIEW_DIR, name)));
  }

  await browser.close();
  console.log('\nDone.');
})().catch((e) => { console.error(e); process.exit(1); });
