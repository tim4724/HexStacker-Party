// @ts-check
const { test, expect } = require('@playwright/test');
const { LOCALES } = require('../../public/shared/i18n.js');

/**
 * The phone device chooser never scrolls: fitDeviceChoice (display.js) drops
 * optional content tier by tier until the column fits. The height it needs
 * depends on locale and fonts, so every locale is checked at sizes spanning
 * each tier: nothing may overflow, clip, or run under the banner's share icon.
 */

const SIZES = [
  [280, 653],  // Galaxy Fold cover: badges wrap to two rows
  [320, 568],  // iPhone SE (1st gen)
  [360, 640],
  [375, 553],  // iPhone SE in Safari, toolbars up
  [390, 664],  // iPhone in Safari
  [411, 733],  // Pixel 7 in Chrome, bottom toolbar
  [430, 832],
  [768, 1024], // tablet portrait
  [950, 700],  // narrow desktop window
  [740, 360],  // phone landscape
  [915, 260],  // phone landscape under Chrome's toolbars: the last tiers
];

async function openChooser(page, lang) {
  await page.setViewportSize({ width: 411, height: 733 });
  await page.goto(`/?lang=${lang}`);
  // Web fonts and the lazy store badges both change what wraps.
  await page.waitForFunction(() => {
    const imgs = [...document.querySelectorAll('#device-choice .store-badge img')];
    return document.fonts.status === 'loaded' && imgs.every((i) => i.complete && i.naturalWidth > 0);
  });
}

// The fit runs from a ResizeObserver, delivered in the next rendering step.
const nextFrames = (page) =>
  page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

async function resize(page, width, height) {
  await page.setViewportSize({ width, height });
  await nextFrames(page);
}

// Runs in the page: everything that would show as clipped or overlapping.
function findIssues() {
  const dc = document.getElementById('device-choice');
  const issues = [];
  if (dc.scrollHeight > dc.clientHeight) issues.push(`overflows by ${dc.scrollHeight - dc.clientHeight}px`);
  if (dc.scrollWidth > dc.clientWidth) issues.push(`overflows sideways by ${dc.scrollWidth - dc.clientWidth}px`);
  const textBox = (el) => { const r = document.createRange(); r.selectNodeContents(el); return r; };
  for (const el of dc.querySelectorAll('*')) {
    if (!el.getClientRects().length) continue;
    const b = el.getBoundingClientRect();
    if (b.left < -0.5 || b.right > innerWidth + 0.5) issues.push(`${el.className || el.tagName} off screen`);
    if (!el.children.length && el.textContent.trim()) {
      const t = textBox(el).getBoundingClientRect();
      if (t.left < b.left - 1 || t.right > b.right + 1) issues.push(`"${el.textContent.trim()}" clipped`);
    }
  }
  const icon = dc.querySelector('.device-choice__banner-icon').getBoundingClientRect();
  for (const el of dc.querySelectorAll('.device-choice__banner-url, .device-choice__banner-sub')) {
    for (const t of textBox(el).getClientRects()) {
      if (t.right > icon.left && t.left < icon.right && t.bottom > icon.top && t.top < icon.bottom) {
        issues.push(`"${el.textContent.trim()}" under the share icon`);
        break;
      }
    }
  }
  return issues;
}

test.describe('Device chooser fit', () => {
  for (const lang of Object.keys(LOCALES)) {
    test(`${lang}: no overflow, clipping or overlap at any tier`, async ({ page }) => {
      await openChooser(page, lang);
      for (const [width, height] of SIZES) {
        await resize(page, width, height);
        expect(await page.evaluate(findIssues), `${lang} ${width}x${height}`).toEqual([]);
      }
    });
  }

  test('a Pixel 7 in Chrome keeps the chips', async ({ page }) => {
    for (const lang of ['en', 'de']) {
      await openChooser(page, lang);
      await expect(page.locator('.device-choice__chips'), lang).toBeVisible();
    }
  });

  test('the bail toast stays on screen and clear of the banner', async ({ page }) => {
    await openChooser(page, 'en');
    // Floating above the CTA, then in the title's place once the title drops.
    for (const [width, height] of [[411, 733], [740, 360], [915, 300]]) {
      await resize(page, width, height);
      await page.evaluate(() => {
        /* global showBailToast */
        showBailToast('room_not_found');
      });
      await nextFrames(page);
      const { toast, banner } = await page.evaluate(() => ({
        toast: document.getElementById('device-choice-toast').getBoundingClientRect().toJSON(),
        banner: document.querySelector('.device-choice__banner').getBoundingClientRect().toJSON(),
      }));
      const at = `${width}x${height}`;
      expect(toast.height, at).toBeGreaterThan(0);
      expect(toast.top, at).toBeGreaterThanOrEqual(0);
      expect(toast.bottom, at).toBeLessThanOrEqual(banner.top);
    }
  });
});
