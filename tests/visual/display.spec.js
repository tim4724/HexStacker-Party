// @ts-check
const { test, expect } = require('@playwright/test');
const {
  gotoDisplayTest,
  stabilizeDisplayLobby,
  waitForFont,
} = require('./helpers');
const { buildPlayers } = require('./hex-fixtures');

async function injectPlayers(page, count) {
  const playerList = buildPlayers(count);
  await page.evaluate((players) => {
    window.__TEST__.addPlayers(players);
  }, playerList);
}

async function showLobby(page) {
  await page.evaluate(() => {
    document.getElementById('lobby-screen').classList.remove('hidden');
    document.getElementById('welcome-screen').classList.add('hidden');
    updatePlayerList();
    updateStartButton();
  });
}

test.describe('Display', () => {
  test('end screen on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/?test=1');
    await waitForFont(page);
    await expect(page).toHaveScreenshot('01-end-screen-mobile.png');
  });

  test('welcome screen', async ({ page }) => {
    await page.goto('/?test=1');
    await waitForFont(page);
    await page.locator('#version-label').evaluate(el => el.textContent = 'X.Y.Z');
    await expect(page).toHaveScreenshot('02-welcome.png');
  });

  test('lobby screen - empty', async ({ page }) => {
    await gotoDisplayTest(page);
    await showLobby(page);
    await stabilizeDisplayLobby(page);
    await expect(page).toHaveScreenshot('03-lobby-empty.png');
  });

  test('lobby screen - with players', async ({ page }) => {
    await gotoDisplayTest(page);
    await showLobby(page);
    await injectPlayers(page, 2);
    await stabilizeDisplayLobby(page);
    await expect(page).toHaveScreenshot('04-lobby-players.png');
  });

  test('lobby screen - full (8 players)', async ({ page }) => {
    await gotoDisplayTest(page);
    await showLobby(page);
    await injectPlayers(page, 8);
    await stabilizeDisplayLobby(page);
    await expect(page).toHaveScreenshot('04a-lobby-full.png');
  });

  test('lobby screen - wide (8 slots)', async ({ page }) => {
    await page.setViewportSize({ width: 2560, height: 1440 });
    await gotoDisplayTest(page);
    await showLobby(page);
    await injectPlayers(page, 3);
    await stabilizeDisplayLobby(page);
    await expect(page).toHaveScreenshot('04b-lobby-wide.png');
  });
});
