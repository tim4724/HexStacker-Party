#!/usr/bin/env node
'use strict';

// Renders the Android raster assets from the same brand primitives as the
// tvOS icon (artwork/tvos-icon.html):
//   - legacy launcher mipmaps (ic_launcher / ic_launcher_round) matching the
//     adaptive icon vectors (with minSdk 28 they are only fallbacks)
//   - the leanback banner (mipmap-*/app_banner.webp) at every density — the
//     brand lockup with the real Orbitron wordmark, which vectors can only
//     approximate
// Encodes lossless webp via cwebp (brew install webp).
//
//   node artwork/generate-android-icons.js          # write mipmaps + previews
//   node artwork/generate-android-icons.js --preview-only

const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const PAGE = path.resolve(__dirname, 'tvos-icon.html');
const RES = path.resolve(ROOT, 'android/tv/src/main/res');
const PREVIEW_DIR = path.resolve(__dirname, 'android-preview');

const PREVIEW_ONLY = process.argv.includes('--preview-only');

// Standard 48dp launcher ladder.
const DENSITIES = [['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192]];
const SHAPES = [['square', 'ic_launcher'], ['round', 'ic_launcher_round']];
// Leanback banner ladder (16:9, xhdpi baseline 320x180).
const BANNERS = [['mdpi', 160, 90], ['hdpi', 240, 135], ['xhdpi', 320, 180], ['xxhdpi', 480, 270], ['xxxhdpi', 640, 360]];

function writeDataUrl(dataUrl, dest) {
  const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(b64, 'base64'));
}

(async () => {
  try {
    execFileSync('cwebp', ['-version'], { stdio: 'ignore' });
  } catch {
    console.error('cwebp not found — install with: brew install webp');
    process.exit(1);
  }

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`file://${PAGE}`);
  await page.waitForFunction(() => window.__TVOS_READY__ === true);
  // The banner wordmark needs the brand font loaded before first paint.
  await page.evaluate(async () => {
    await document.fonts.load('900 200px Orbitron');
    await document.fonts.ready;
  });

  const render = (spec) => page.evaluate((s) => window.renderLauncherIcon(s), spec);
  const renderBanner = (w, h) => page.evaluate((s) => window.renderBanner(s), { w, h });
  const toWebp = (png, dest) => execFileSync('cwebp', ['-lossless', '-z', '9', '-quiet', png, '-o', dest]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hexicons-'));

  if (!PREVIEW_ONLY) {
    for (const [density, size] of DENSITIES) {
      for (const [shape, name] of SHAPES) {
        const png = path.join(tmp, `${name}-${density}.png`);
        writeDataUrl(await render({ size, shape }), png);
        const dest = path.join(RES, `mipmap-${density}`, `${name}.webp`);
        toWebp(png, dest);
        console.log('asset  ', path.relative(ROOT, dest));
      }
    }
    for (const [density, w, h] of BANNERS) {
      const png = path.join(tmp, `app_banner-${density}.png`);
      writeDataUrl(await renderBanner(w, h), png);
      const dest = path.join(RES, `mipmap-${density}`, 'app_banner.webp');
      toWebp(png, dest);
      console.log('asset  ', path.relative(ROOT, dest));
    }
  }
  fs.mkdirSync(PREVIEW_DIR, { recursive: true });
  for (const [shape, name] of SHAPES) {
    const dest = path.join(PREVIEW_DIR, `${name}-192.png`);
    writeDataUrl(await render({ size: 192, shape }), dest);
    console.log('preview', path.relative(ROOT, dest));
  }
  writeDataUrl(await renderBanner(640, 360), path.join(PREVIEW_DIR, 'app_banner-640.png'));
  console.log('preview', path.relative(ROOT, path.join(PREVIEW_DIR, 'app_banner-640.png')));
  fs.rmSync(tmp, { recursive: true, force: true });

  await browser.close();
  console.log('\nDone.');
})().catch((e) => { console.error(e); process.exit(1); });
