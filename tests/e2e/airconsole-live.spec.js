// @ts-check
const { test, expect, chromium, firefox, devices } = require('@playwright/test');

/**
 * AirConsole Live E2E tests using the real AirConsole platform.
 *
 * Opens the screen via airconsole.com, extracts the pairing code,
 * connects a controller via HTTP AirConsole with the code, clicks
 * through onboarding, then tests the full game lifecycle.
 *
 * Local mode uses Firefox + HTTP AirConsole (avoids Chrome Private Network Access).
 * Remote mode uses Chrome + HTTPS AirConsole.
 *
 * Run:
 *   npx playwright test --project=e2e-airconsole-live              # local (:4100)
 *   AC_GAME_URL=https://... npx playwright test --project=e2e-airconsole-live
 */

const GAME_URL = process.env.AC_GAME_URL || 'http://localhost:4100';
const IS_LOCAL = GAME_URL.includes('localhost') || GAME_URL.includes('127.0.0.1');

function getScreenURL() {
  if (IS_LOCAL) {
    return { screen: 'http://http.airconsole.com/?http=1&#' + GAME_URL + '/' };
  }
  return { screen: 'https://www.airconsole.com/#' + GAME_URL + '/' };
}

async function waitForFrame(page, urlSubstring, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const frame = page.frames().find(f => f.url().includes(urlSubstring));
    if (frame) return frame;
    await page.waitForTimeout(500);
  }
  throw new Error('Frame "' + urlSubstring + '" not found within ' + timeout + 'ms');
}

async function getPairingCode(screenPage) {
  const acFrame = await waitForFrame(screenPage, 'frontend', 15000);
  await acFrame.waitForFunction(() => /\d{3}\s+\d{3}/.test(document.body.innerText), null, { timeout: 30000 });
  return await acFrame.evaluate(() => {
    const match = document.body.innerText.match(/(\d{3}\s+\d{3}(?:\s+\d+)?)/);
    return match ? match[1].replace(/\s/g, '') : null;
  });
}

/**
 * Connect controller. For local HTTP mode, uses http://http.airconsole.com
 * with role=controller and code in hash — skips all onboarding.
 * For remote HTTPS mode, uses the deeplink and clicks through onboarding.
 */
async function connectController(ctrlContext, code, ctrlPage) {
  if (IS_LOCAL) {
    // HTTP mode: direct URL with code — skips Spiele im Browser, privacy, app install
    await ctrlPage.goto('http://http.airconsole.com/?http=1&role=controller#!code=' + code);
    await ctrlPage.waitForTimeout(5000);
    const cf = await waitForFrame(ctrlPage, 'airconsole-controller', 10000);
    // Just need to click "Ja" / "Yes"
    await cf.locator('button', { hasText: /ja|yes/i }).first().click({ timeout: 10000 });
  } else {
    // HTTPS mode: deeplink → name → confirm
    await ctrlPage.goto('http://aircn.sl/_' + code);
    await ctrlPage.waitForTimeout(5000);
    const cf = await waitForFrame(ctrlPage, 'airconsole-controller', 10000);
    await cf.locator('input').fill('TestPlayer');
    await cf.locator('button', { hasText: /weiter|continue/i }).click();
    await ctrlPage.waitForTimeout(2000);
    await cf.locator('button', { hasText: /ja|yes/i }).click({ timeout: 10000 });
  }
}

test.describe.serial('AirConsole Live', () => {
  test.setTimeout(180000);

  let browser;
  let screenCtx;
  let ctrlCtx;

  test.beforeAll(async () => {
    if (IS_LOCAL) {
      // Firefox doesn't enforce Private Network Access — can load local HTTP
      browser = await firefox.launch({ headless: false });
      screenCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      ctrlCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    } else {
      browser = await chromium.launch({
        headless: false,
        channel: 'chrome',
        args: ['--disable-blink-features=AutomationControlled'],
        ignoreDefaultArgs: ['--enable-automation'],
      });
      screenCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      const iPhone = devices['iPhone 14'];
      ctrlCtx = await browser.newContext({ ...iPhone });
    }
  });

  test.afterAll(async () => {
    if (browser) await browser.close();
  });

  test('full lifecycle: pairing → lobby → game → results', async () => {
    const urls = getScreenURL();

    // 1. Open screen
    const screenPage = await screenCtx.newPage();
    await screenPage.goto(urls.screen, { waitUntil: 'domcontentloaded' });
    await screenPage.waitForTimeout(IS_LOCAL ? 20000 : 10000);

    // 2. Get pairing code
    const code = await getPairingCode(screenPage);
    expect(code).toBeTruthy();

    // 3. Connect controller
    const ctrlPage = await ctrlCtx.newPage();
    await connectController(ctrlCtx, code, ctrlPage);

    // 4. Wait for game frames
    const screenFrame = await waitForFrame(screenPage, 'screen.html', 30000);
    const ctrlFrame = await waitForFrame(ctrlPage, 'controller.html', 30000);

    // 5. Verify screen lobby
    await screenFrame.waitForFunction(() => {
      return typeof party !== 'undefined' && party && party._ready
        && typeof currentScreen !== 'undefined' && currentScreen === 'lobby';
    }, null, { timeout: 15000 });
    expect(await screenFrame.evaluate(() => party.constructor.name)).toBe('AirConsoleAdapter');
    await screenFrame.waitForFunction(() => players.size >= 1, null, { timeout: 15000 });

    // 6. Verify controller lobby (proves bidirectional messaging)
    await ctrlFrame.waitForFunction(() => {
      return typeof currentScreen !== 'undefined' && currentScreen === 'lobby'
        && typeof playerColor !== 'undefined' && playerColor !== null;
    }, null, { timeout: 15000 });

    // 7. Start game at high level
    await ctrlFrame.evaluate(() => {
      const plus = document.getElementById('level-plus-btn');
      for (let i = 0; i < 14; i++) plus.click();
    });
    await ctrlPage.waitForTimeout(300);
    await ctrlFrame.locator('#start-btn').click();

    // 8. Verify game
    await screenFrame.waitForFunction(() => roomState === 'playing', null, { timeout: 15000 });
    await ctrlFrame.waitForSelector('#game-screen:not(.hidden):not(.countdown)', { timeout: 15000 });

    // 9. Wait for results
    await screenFrame.waitForSelector('#results-screen:not(.hidden)', { timeout: 60000 });
    await ctrlFrame.waitForSelector('#gameover-screen:not(.hidden)', { timeout: 60000 });
    expect(await screenFrame.evaluate(() => roomState)).toBe('results');

    await screenPage.close();
    await ctrlPage.close();
  });
});
