#!/usr/bin/env node
'use strict';

// Store screenshots for the App Store (Apple TV) and Google Play (Android TV) in
// every store language, built from the tvOS gallery captures (see README.md).
// Captions live in locales.json. Writes artwork/store/output/:
//   appstore/<lang>/01..07.png  captioned, 3840x2160
//   play/<lang>/01..08.png      the captioned frames minus the phone opener, plus
//                               two unaltered captures (TV quality criterion TV-G4)
//   play-feature-graphic.png    1024x500, the builder's social stage
//   play-tv-banner.png          1280x720, the leanback banner lockup
// Usage: node artwork/store/screenshots.js [lang ...]   (default: all languages)

const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(__dirname, 'output');
const LOCALES = require('./locales.json');
const shotsDir = (app) => path.join(ROOT, 'scripts/gallery/shots', app === 'en' ? 'tvos' : `tvos-${app}`);

// [output name, capture key]; the opener is a fixed composite, not a capture.
const FRAMES = [
  ['01-phone-controller', null],
  ['02-lobby', 'lobby'],
  ['03-head-to-head', 'game-2p'],
  ['04-four-players', 'game-4p'],
  ['05-eight-players', 'game-8p'],
  ['06-high-level', 'game-lv12'],
  ['07-results', 'results'],
];
const PLAIN = [['07-lobby-8p-plain', 'lobby-8p'], ['08-game-3p-plain', 'game-3p']];

// Baloo 2 only covers Latin; other scripts get the macOS face closest to it in spirit.
const SCRIPT_FACE = { ja: "'Hiragino Sans', ", zh: "'PingFang SC', ", ko: "'Apple SD Gothic Neo', ", ru: 'system-ui, ' };
const FONTS = path.join(ROOT, 'public/shared/fonts');
const FONT_CSS = `
@font-face { font-family: 'Baloo 2'; font-weight: 400 800; src: url('file://${FONTS}/Baloo2-latin.woff2') format('woff2'); unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+2074, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD; }
@font-face { font-family: 'Baloo 2'; font-weight: 400 800; src: url('file://${FONTS}/Baloo2-latin-ext.woff2') format('woff2'); unicode-range: U+0100-02AF, U+0304, U+0308, U+0329, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF; }`;
const STACK = `'Baloo 2', 'Hiragino Maru Gothic ProN', 'Hiragino Sans', 'PingFang SC', 'Apple SD Gothic Neo', 'Arial Rounded MT Bold', system-ui, sans-serif`;

const frameHTML = (locale, caption, img) => `<!doctype html><html lang="${locale.asc}"><head><meta charset="utf-8"><style>
${FONT_CSS}
html,body{margin:0;width:1920px;height:1080px;overflow:hidden}
body{background:radial-gradient(ellipse 90% 70% at 50% 0%, #332a4a 0%, #1E1A2B 60%, #17131F 100%);
  font-family:${SCRIPT_FACE[locale.app] || ''}${STACK};color:#F7F1E8}
.cap{position:absolute;top:0;left:0;right:0;height:196px;display:flex;align-items:center;justify-content:center;
  font-weight:800;font-size:70px;letter-spacing:0.005em;text-align:center;padding:0 120px;box-sizing:border-box;white-space:nowrap}
.shot{position:absolute;left:50%;top:200px;width:1480px;height:832.5px;transform:translateX(-50%);
  border-radius:22px;overflow:hidden;box-shadow:0 28px 80px rgba(0,0,0,.55),0 0 0 1.5px rgba(255,248,236,.10)}
.shot img{width:100%;height:100%;object-fit:cover;display:block}
</style></head><body><div class="cap">${caption}</div><div class="shot"><img src="file://${img}"></div></body></html>`;

// Play rejects PNGs with an alpha channel, which Simulator screenshots carry.
const flatten = (from, to) => execFileSync('magick', [from, '-background', '#1E1A2B', '-alpha', 'remove', '-alpha', 'off', to]);

async function renderLocale(page, locale) {
  const shots = shotsDir(locale.app);
  if (!fs.existsSync(shots)) throw new Error(`no captures for ${locale.app} in ${shots}`);
  const appstore = path.join(OUT, 'appstore', locale.app);
  const play = path.join(OUT, 'play', locale.app);
  fs.mkdirSync(appstore, { recursive: true });
  fs.mkdirSync(play, { recursive: true });
  for (const [i, [name, key]] of FRAMES.entries()) {
    const img = key ? path.join(shots, `${key}.png`) : path.join(ROOT, 'artwork/gameplay-16x9.png');
    // A file:// page, so the frame may load the file:// capture and fonts.
    const html = path.join(OUT, '_frame.html');
    fs.writeFileSync(html, frameHTML(locale, locale.captions[i], img));
    await page.goto(`file://${html}`, { waitUntil: 'load' });
    fs.unlinkSync(html);
    await page.evaluate(async () => {
      await document.fonts.ready;
      // Long translations shrink to fit one line inside the gutter.
      const cap = document.querySelector('.cap');
      let size = 70;
      while (cap.scrollWidth > cap.clientWidth && size > 44) cap.style.fontSize = `${--size}px`;
    });
    await page.screenshot({ path: path.join(appstore, `${name}.png`) });
  }
  // Play: the same frames minus the phone-mockup opener (Play discourages device imagery).
  FRAMES.slice(1).forEach(([name], i) =>
    fs.copyFileSync(path.join(appstore, `${name}.png`), path.join(play, `${String(i + 1).padStart(2, '0')}${name.slice(2)}.png`)));
  for (const [name, key] of PLAIN) flatten(path.join(shots, `${key}.png`), path.join(play, `${name}.png`));
  console.log(`${locale.app}: ${FRAMES.length} App Store + ${FRAMES.length - 1 + PLAIN.length} Play screenshots`);
}

async function renderPlayGraphics(browser) {
  const feature = await browser.newPage({ viewport: { width: 1024, height: 500 } });
  await feature.goto(`file://${path.join(ROOT, 'artwork/builder.html')}?headless=social&w=1024&h=500`);
  await feature.evaluate(() => document.fonts.ready);
  await feature.waitForTimeout(300);
  const err = await feature.evaluate(() => window.__BUILDER_ERROR__);
  if (err) throw new Error(`builder.html reported: ${err}`);
  await feature.screenshot({ path: path.join(OUT, 'play-feature-graphic.png') });

  const banner = await browser.newPage();
  await banner.goto(`file://${path.join(ROOT, 'artwork/tvos-icon.html')}`);
  await banner.waitForFunction(() => window.__TVOS_READY__ === true);
  await banner.evaluate(async () => { await document.fonts.load('800 100px "Baloo 2"'); await document.fonts.ready; });
  const url = await banner.evaluate(() => window.renderBanner({ w: 1280, h: 720 }));
  const tmp = path.join(OUT, '_banner.png');
  fs.writeFileSync(tmp, Buffer.from(url.replace(/^data:image\/png;base64,/, ''), 'base64'));
  flatten(tmp, path.join(OUT, 'play-tv-banner.png'));
  fs.unlinkSync(tmp);
  console.log('Play feature graphic + TV banner');
}

(async () => {
  const wanted = process.argv.slice(2);
  const locales = wanted.length ? LOCALES.filter((l) => wanted.includes(l.app)) : LOCALES;
  if (locales.length !== (wanted.length || LOCALES.length)) throw new Error(`unknown language in: ${wanted.join(' ')}`);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });
  for (const locale of locales) await renderLocale(page, locale);
  await renderPlayGraphics(browser);
  await browser.close();
  console.log(`Wrote ${OUT}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
