#!/usr/bin/env node
'use strict';

// Renders the tvOS Top Shelf images (the fullscreen showcase shown when the app
// is focused on the Home screen) from the gameplay key art. Apple's tvOS HIG
// wants rich, full-bleed key art here (vs a simple logo for the app icon), so
// this uses artwork/gameplay-2x1.png contain-fit onto the brand plum radial —
// the side margins blend into the banner's own dark-plum background, so it reads
// edge-to-edge without cropping the boards/players. The app icon is produced
// separately by generate-tvos-icons.js.
//
//   node artwork/generate-tvos-topshelf.js

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const PAGE = path.resolve(__dirname, 'tvos-icon.html');
const BANNER = path.resolve(__dirname, 'gameplay-2x1.png');
const XC = path.resolve(ROOT,
  'appletv/Sources/HexStackerTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets');

const TS = path.join(XC, 'Top Shelf Image.imageset');
const TSW = path.join(XC, 'Top Shelf Image Wide.imageset');

// [destAbsPath, width, height]
const ASSETS = [
  [path.join(TS,  'topshelf-1920x720.png'),      1920, 720],
  [path.join(TS,  'topshelf-3840x1440.png'),     3840, 1440],
  [path.join(TSW, 'topshelfwide-2320x720.png'),  2320, 720],
  [path.join(TSW, 'topshelfwide-4640x1440.png'), 4640, 1440],
];

(async () => {
  const bannerDataUrl = 'data:image/png;base64,' + fs.readFileSync(BANNER).toString('base64');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`file://${PAGE}`);
  await page.waitForFunction(() => window.__TVOS_READY__ === true);

  const render = (w, h) => page.evaluate((s) => window.renderTopShelf(s), { w, h, bannerDataUrl });

  for (const [dest, w, h] of ASSETS) {
    const url = await render(w, h);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.from(url.replace(/^data:image\/png;base64,/, ''), 'base64'));
    console.log('topshelf', path.relative(ROOT, dest));
  }

  await browser.close();
  console.log('\nDone.');
})().catch((e) => { console.error(e); process.exit(1); });
