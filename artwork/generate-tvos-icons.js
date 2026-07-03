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
// sizeFrac 0.20 — verified inside the 370x222 safe zone (of 400x240) and
// legible at the 300x180 unfocused size; see artwork/tvos-preview/*.
//
//   node artwork/generate-tvos-icons.js          # write assets + previews
//   node artwork/generate-tvos-icons.js --preview-only
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
const PREVIEW_DIR = path.resolve(__dirname, 'tvos-preview');

const PREVIEW_ONLY = process.argv.includes('--preview-only');

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

// Previews for visual review: flattened composites, the unfocused shelf size,
// front-only (transparency check), and a 3-tilt parallax strip.
const PREVIEWS = [
  ['icon-5x3.png',        iconSpec('flat', 800, 480)],
  ['appstore-5x3.png',    iconSpec('flat', 1280, 768)],
  ['icon-unfocused.png',  iconSpec('flat', 300, 180)],
  ['icon-front-only.png', iconSpec('front', 800, 480)],
];

async function writeDataUrl(dataUrl, dest) {
  const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(b64, 'base64'));
}

// Compose back/front at three parallax tilts (as the focus engine would:
// the deeper layer shifts and scales less) with the tvOS rounded-corner mask,
// so depth and edge-crop risk can be judged from a single strip.
function composeParallax(page, urls, w, h) {
  return page.evaluate(async ({ urls, w, h }) => {
    const load = (src) => new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('layer image failed to load'));
      i.src = src;
    });
    const [back, front] = await Promise.all(urls.map(load));
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
      for (const [img, s, shift] of [[back, 1.03, 5], [front, 1.10, 16]]) {
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
  for (const layer of ['back', 'front']) layerUrls.push(await render(iconSpec(layer, 800, 480)));
  await writeDataUrl(await composeParallax(page, layerUrls, 800, 480), path.join(PREVIEW_DIR, 'icon-parallax.png'));
  console.log('preview', path.relative(ROOT, path.join(PREVIEW_DIR, 'icon-parallax.png')));

  await browser.close();
  console.log('\nDone.');
})().catch((e) => { console.error(e); process.exit(1); });
