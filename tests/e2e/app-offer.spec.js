// @ts-check
// A fresh join in a phone browser leads with the Paper Balloon app
// (showAppOffer in controller.js); the browser stays one tap away.
// tests/app-offer.test.js covers the links themselves.
const { test, expect } = require('@playwright/test');
const { createRoom } = require('./helpers');

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

async function openPhone(browser, baseURL, roomCode, userAgent) {
  const context = await browser.newContext({
    baseURL, userAgent, viewport: { width: 390, height: 664 }, isMobile: true, hasTouch: true,
  });
  const phone = await context.newPage();
  await phone.goto(`/${roomCode}?test=1`);
  return { context, phone };
}

test.describe('App offer', () => {
  test('an iPhone is offered the App Clip, then joins in the browser', async ({ page, browser }, testInfo) => {
    const { roomCode } = await createRoom(page);
    const { context, phone } = await openPhone(browser, testInfo.project.use.baseURL, roomCode, IPHONE);

    await expect(phone.locator('#app-offer')).toBeVisible();
    await expect(phone.locator('#name-input')).toBeHidden();
    const link = new URL(await phone.locator('#app-offer-link').getAttribute('href') || '');
    expect(link.host).toBe('appclip.apple.com');
    expect(link.searchParams.get('url')).toBe(phone.url());

    await phone.tap('#app-offer-browser-btn');
    await expect(phone.locator('#app-offer')).toBeHidden();
    await expect(phone.locator('#name-input')).toBeFocused();
    await phone.fill('#name-input', 'Alice');
    await phone.tap('#name-join-btn');
    await phone.waitForSelector('#player-identity:not(.hidden)', { timeout: 10000 });
    await context.close();
  });

  test('Chrome on Android gets an intent link to the app', async ({ page, browser }, testInfo) => {
    const { roomCode } = await createRoom(page);
    const { context, phone } = await openPhone(browser, testInfo.project.use.baseURL, roomCode, ANDROID_CHROME);

    await expect(phone.locator('#app-offer')).toBeVisible();
    const href = await phone.locator('#app-offer-link').getAttribute('href') || '';
    expect(href.startsWith('intent://')).toBe(true);
    expect(href).toContain(';package=games.paperballoon.controller;');
    await context.close();
  });
});
