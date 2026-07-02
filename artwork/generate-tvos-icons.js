#!/usr/bin/env node
'use strict';

// Renders the layered tvOS App Icon (small + App Store) from the HexStacker
// brand primitives (artwork/tvos-icon.html) and writes them into the tvOS asset
// catalog. Per the tvOS HIG the icon is a single centered focal point with no
// text (the shelf shows the app name itself): the 4-hex "gem" mark — identical
// geometry to the Android adaptive icon / leanback banner — over a plum radial.
// Three parallax layers: BACK (opaque plum + faint honeycomb + the gem's soft
// glow), MIDDLE (the gem), FRONT (two small falling-piece accents on
// transparency; crops the most when focused, so nothing essential lives here).
// Uses canvas.toDataURL so the upper layers keep real alpha. The Top Shelf
// (the fullscreen showcase) is the gameplay key art, generated separately by
// generate-tvos-topshelf.js — Apple's HIG wants rich key art there and a simple
// logo for the icon, so the two assets are produced by different scripts.
//
//   node artwork/generate-tvos-icons.js          # write assets + previews
//   node artwork/generate-tvos-icons.js --preview-only
//
// Layouts are normalized (nx/ny in 0..1; sizeFrac = hex circumradius / height)
// so one layout renders at every scale of the icon. Safe zone at 400x240 is
// 370x222 (unfocused display is 300x180) — the gem and front accents must stay
// inside it.

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const PAGE = path.resolve(__dirname, 'tvos-icon.html');
const XC = path.resolve(ROOT,
  'appletv/Sources/HexStackerTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets');
const PREVIEW_DIR = path.resolve(__dirname, 'tvos-preview');

const PREVIEW_ONLY = process.argv.includes('--preview-only');

// ---- Layout ---------------------------------------------------------------
// Gem centered; total gem height = (2 + √3)·s ≈ 3.73·s → sizeFrac 0.165 gives
// ~62% of icon height, comfortably inside the 370x222 safe zone. Front accents
// sit in opposite corners, clear of the gem and inside the safe zone.
const GEM = { nx: 0.5, ny: 0.5, sizeFrac: 0.165 };
const ICON = {
  gem: GEM,
  gemGlow: { ...GEM, alpha: 0.42, blurFrac: 0.055 },
  outlineHexes: [
    { nx: 0.075, ny: 0.78, sizeFrac: 0.09, alpha: 0.07 },
    { nx: 0.155, ny: 0.915, sizeFrac: 0.09, alpha: 0.07 },
    { nx: 0.905, ny: 0.13, sizeFrac: 0.09, alpha: 0.07 },
    { nx: 0.975, ny: 0.265, sizeFrac: 0.09, alpha: 0.07 },
  ],
  pieces: [
    { type: 'V3', nx: 0.145, ny: 0.20, sizeFrac: 0.048, rot: 5, trailFrac: 0.22 },
    { type: 'o',  nx: 0.86,  ny: 0.78, sizeFrac: 0.048, rot: 0 },
  ],
};

function iconSpec(layer, w, h) {
  return { w, h, layer, ...ICON };
}

// ---- Asset manifest: [destAbsPath, spec] --------------------------------
const ICONSTACK = path.join(XC, 'App Icon.imagestack');
const APPSTORE = path.join(XC, 'App Icon - App Store.imagestack');

const ASSETS = [
  // small App Icon — layered
  [path.join(ICONSTACK, 'Back.imagestacklayer/Content.imageset/back-400x240.png'),      iconSpec('back', 400, 240)],
  [path.join(ICONSTACK, 'Back.imagestacklayer/Content.imageset/back-800x480.png'),      iconSpec('back', 800, 480)],
  [path.join(ICONSTACK, 'Middle.imagestacklayer/Content.imageset/middle-400x240.png'),  iconSpec('middle', 400, 240)],
  [path.join(ICONSTACK, 'Middle.imagestacklayer/Content.imageset/middle-800x480.png'),  iconSpec('middle', 800, 480)],
  [path.join(ICONSTACK, 'Front.imagestacklayer/Content.imageset/front-400x240.png'),    iconSpec('front', 400, 240)],
  [path.join(ICONSTACK, 'Front.imagestacklayer/Content.imageset/front-800x480.png'),    iconSpec('front', 800, 480)],
  // App Store icon — layered, single scale
  [path.join(APPSTORE, 'Back.imagestacklayer/Content.imageset/appstore-back-1280x768.png'),     iconSpec('back', 1280, 768)],
  [path.join(APPSTORE, 'Middle.imagestacklayer/Content.imageset/appstore-middle-1280x768.png'), iconSpec('middle', 1280, 768)],
  [path.join(APPSTORE, 'Front.imagestacklayer/Content.imageset/appstore-front-1280x768.png'),   iconSpec('front', 1280, 768)],
];

// Previews for visual review: flattened composites, the unfocused shelf size,
// front-only (transparency check), and a 3-tilt parallax strip.
const PREVIEWS = [
  ['icon-5x3.png',          iconSpec('flat', 800, 480)],
  ['appstore-5x3.png',      iconSpec('flat', 1280, 768)],
  ['icon-unfocused.png',    iconSpec('flat', 300, 180)],
  ['icon-front-only.png',   iconSpec('front', 800, 480)],
];

async function writeDataUrl(dataUrl, dest) {
  const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(b64, 'base64'));
}

// Compose back/middle/front at three parallax tilts (as the focus engine would:
// deeper layers shift and scale less) with the tvOS rounded-corner mask, so
// depth and edge-crop risk can be judged from a single strip.
function composeParallax(page, urls, w, h) {
  return page.evaluate(async ({ urls, w, h }) => {
    const load = (src) => new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('layer image failed to load'));
      i.src = src;
    });
    const [back, middle, front] = await Promise.all(urls.map(load));
    const tilts = [-1, 0, 1], pad = 24;
    const c = document.createElement('canvas');
    c.width = tilts.length * w + pad * (tilts.length - 1);
    c.height = h;
    const ctx = c.getContext('2d');
    tilts.forEach((t, i) => {
      const ox = i * (w + pad);
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(ox, 0, w, h, h * 0.06);
      ctx.clip();
      for (const [img, s, shift] of [[back, 1.03, 5], [middle, 1.07, 12], [front, 1.12, 20]]) {
        const dw = w * s, dh = h * s;
        ctx.drawImage(img, ox + (w - dw) / 2 + t * shift * (w / 800), (h - dh) / 2, dw, dh);
      }
      ctx.restore();
    });
    return c.toDataURL('image/png');
  }, { urls, w, h });
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`file://${PAGE}`);
  await page.waitForFunction(() => window.__TVOS_READY__ === true);

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
  const layerUrls = [];
  for (const layer of ['back', 'middle', 'front']) layerUrls.push(await render(iconSpec(layer, 800, 480)));
  await writeDataUrl(await composeParallax(page, layerUrls, 800, 480), path.join(PREVIEW_DIR, 'icon-parallax.png'));
  console.log('preview', path.relative(ROOT, path.join(PREVIEW_DIR, 'icon-parallax.png')));

  await browser.close();
  console.log('\nDone.');
})().catch((e) => { console.error(e); process.exit(1); });
