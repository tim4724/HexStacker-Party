// @ts-check
const { test, expect } = require('@playwright/test');

/**
 * WelcomeBackground repaints only the boxes its pieces cover (_pieceBox),
 * under a clip, instead of the whole canvas each frame. That is only correct
 * while _pieceBox bounds everything _drawPiece paints: if a piece ever draws
 * outside it, the partial repaint leaves trails. Two instances fed the same
 * pieces and random stream, one forced to repaint fully every frame, must end
 * up pixel-identical after nudging, a click-spawned extra and recycling.
 *
 * Also pins the phone landing page: the opaque device-choice overlay covers
 * the canvas, so neither the loop nor the gradient bake may run under it.
 */

// Runs in the page: steps both copies 600 frames and returns the diff.
function compareRepaints() {
  /* global welcomeBg, WelcomeBackground */
  welcomeBg.stop();
  const mk = () => {
    const c = document.createElement('canvas');
    document.body.appendChild(c);
    const bg = new WelcomeBackground(c, 15, welcomeBg.gradient);
    bg.resize(welcomeBg.w, welcomeBg.h);
    return bg;
  };
  const partial = mk();
  const full = mk();
  // Identical pools, pulled into view so every piece is on screen from frame one.
  partial.pool = welcomeBg.pool.map((p) => ({ ...p, y: Math.abs(p.y) % welcomeBg.h, box: undefined, ext: undefined }));
  full.pool = partial.pool.map((p) => ({ ...p }));
  partial._cols = full._cols = welcomeBg._cols;
  partial._nextCol = full._nextCol = 0;

  const realRaf = window.requestAnimationFrame;
  const realRandom = Math.random;
  window.requestAnimationFrame = () => 0; // frames are driven by hand below
  // Same seed per call site on both copies: recycled and spawned shapes match.
  const seeded = (seed) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  try {
    for (let f = 0; f < 600; f++) {
      const t = 1000 + f * 16.7 + (f % 7) * 3; // uneven frame times
      for (const bg of [partial, full]) {
        if (f === 100) bg.setPointer(300, 300);
        if (f === 150) { Math.random = seeded(42); bg.spawnAt(320, 200); }
        if (f === 400) bg.setPointer(null);
        if (bg === full) bg._fullRedraw = true;
        Math.random = seeded(Math.round(t));
        bg._loop(t);
      }
    }
  } finally {
    window.requestAnimationFrame = realRaf;
    Math.random = realRandom;
  }

  const a = partial.ctx.getImageData(0, 0, partial.canvas.width, partial.canvas.height).data;
  const b = full.ctx.getImageData(0, 0, full.canvas.width, full.canvas.height).data;
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
  // Guard against a vacuous pass: the reference frame must show pieces.
  let ink = 0;
  for (let i = 0; i < b.length; i += 4) if (b[i] !== b[0] || b[i + 1] !== b[1] || b[i + 2] !== b[2] || b[i + 3] !== b[3]) ink++;
  return { diff, ink, pieces: full.pool.length };
}

test.describe('Welcome background', () => {
  test('display: partial repaint over the dithered gradient matches a full repaint', async ({ page }) => {
    await page.goto('/?test=1&bg=1');
    await page.waitForFunction(() => typeof welcomeBg !== 'undefined' && welcomeBg && welcomeBg.gradientBitmap);
    const r = await page.evaluate(compareRepaints);
    expect(r.ink).toBeGreaterThan(1000);
    expect(r.diff).toBe(0);
  });

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true });

    test('controller: partial repaint on a transparent canvas matches a full repaint', async ({ page }) => {
      await page.goto('/GALLERY?test=1&bg=1&scenario=lobby-host');
      await page.waitForFunction(() => typeof welcomeBg !== 'undefined' && welcomeBg && welcomeBg.w > 0);
      const r = await page.evaluate(compareRepaints);
      expect(r.ink).toBeGreaterThan(1000);
      expect(r.diff).toBe(0);
    });

    test('display: the loop and gradient bake wait under the device-choice overlay', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('#device-choice')).toBeVisible();
      const state = () => page.evaluate(() => ({
        running: welcomeBg.running, ticking: !!welcomeBg.rafId, baked: !!welcomeBg.gradientBitmap,
      }));
      // Covered from the start: neither the frames nor the gradient bake run.
      await expect.poll(state).toEqual({ running: true, ticking: false, baked: false });

      await page.locator('#device-choice-continue').click();
      await expect(page.locator('#device-choice')).toBeHidden();
      await expect.poll(state).toEqual({ running: true, ticking: true, baked: true });

      await page.goBack();
      await expect(page.locator('#device-choice')).toBeVisible();
      await expect.poll(state).toEqual({ running: true, ticking: false, baked: true });
    });
  });
});
