// @ts-check
const { test, expect } = require('@playwright/test');
const {
  createRoom,
  waitForDisplayPlayers,
  waitForFont,
} = require('./helpers');

const HX_NAME_RE = /^HX-(?:[1-9][0-9]?)$/;
const BLOCKED_HX_NAMES = new Set(['HX-4', 'HX-13', 'HX-17', 'HX-69']);

async function joinEmptyController(context, roomCode, preferredAutoName) {
  const page = await context.newPage();
  await page.addInitScript(({ rc, autoName }) => {
    localStorage.removeItem('clientId_' + rc);
    localStorage.removeItem('stacker_player_name');
    if (autoName) localStorage.setItem('stacker_auto_player_name', autoName);
  }, { rc: roomCode, autoName: preferredAutoName || '' });
  await page.goto(`/${roomCode}?test=1`);
  await waitForFont(page);
  await page.click('#name-join-btn');
  await page.waitForSelector('#player-identity:not(.hidden)', { timeout: 10000 });
  return page;
}

async function displayNames(page) {
  return page.locator('#player-list .player-card:not(.empty) .identity-name').evaluateAll((els) => (
    els.map((el) => el.textContent.trim())
  ));
}

test.describe('Auto player names', () => {
  test('empty joins get unique persisted HX names that survive lobby compaction', async ({ page, context }) => {
    const { roomCode } = await createRoom(page);

    const c1 = await joinEmptyController(context, roomCode);
    await waitForDisplayPlayers(page, 1);
    const c1Name = await c1.locator('#player-identity-name').textContent();

    expect(c1Name).toMatch(HX_NAME_RE);
    expect(BLOCKED_HX_NAMES.has(c1Name)).toBe(false);
    await expect.poll(() => c1.evaluate(() => localStorage.getItem('stacker_auto_player_name'))).toBe(c1Name);
    await expect(c1.locator('#name-input')).toHaveValue('');

    const c2 = await joinEmptyController(context, roomCode, c1Name);
    await waitForDisplayPlayers(page, 2);
    const c2Name = await c2.locator('#player-identity-name').textContent();

    expect(c2Name).toMatch(HX_NAME_RE);
    expect(BLOCKED_HX_NAMES.has(c2Name)).toBe(false);
    expect(c2Name).not.toBe(c1Name);
    await expect.poll(() => c2.evaluate(() => localStorage.getItem('stacker_auto_player_name'))).toBe(c2Name);

    await expect.poll(() => displayNames(page)).toEqual([c1Name, c2Name]);

    await c1.evaluate(() => window.performDisconnect());
    await expect.poll(() => displayNames(page)).toEqual([c2Name]);
  });
});
