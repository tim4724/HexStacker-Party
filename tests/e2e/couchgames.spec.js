// @ts-check
const { test, expect } = require('@playwright/test');
const {
  createRoom,
  waitForDisplayPlayers,
  waitForFont,
} = require('./helpers');

/**
 * Couch Games Controller Contract v1 (?cgv=1) against a stubbed launcher
 * bridge: the join URL injects the player name, the shell drives live
 * renames via window.CouchGames.setName(), and terminal session ends
 * surface through window.CouchGamesHost.gameEnded(reason) instead of a
 * navigation to the display root.
 */

async function joinCouchController(context, roomCode, name) {
  const page = await context.newPage();
  await page.addInitScript((rc) => {
    localStorage.removeItem('clientId_' + rc);
    window.__cgEnded = [];
    window.CouchGamesHost = {
      gameEnded: (reason) => window.__cgEnded.push(reason),
    };
  }, roomCode);
  await page.goto(`/${roomCode}?test=1&cgv=1&cgName=${encodeURIComponent(name)}`);
  await waitForFont(page);
  return page;
}

// Fabricate the relay's answer for a room that must not exist, so the test
// doesn't depend on production-relay state for the negative path.
async function fakeRoomNotFound(page) {
  await page.routeWebSocket(/ws\.hexstacker\.com/, (ws) => {
    ws.onMessage(() => {
      ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
    });
  });
}

test.describe('Couch Games shell contract', () => {
  test('join with cgName, live rename, and display close → gameEnded', async ({ page, context }) => {
    const { roomCode } = await createRoom(page);
    const controller = await joinCouchController(context, roomCode, 'Zoë');

    // Name screen skipped: the injected name lands in the lobby directly.
    await controller.waitForSelector('#player-identity:not(.hidden)', { timeout: 10000 });
    await expect(controller.locator('#player-identity-name')).toHaveText('Zoë');
    await expect(controller.locator('#name-screen')).toBeHidden();
    await expect(controller.locator('#lobby-back-btn')).toBeHidden();
    await waitForDisplayPlayers(page, 1);
    await expect(page.locator('#player-list')).toContainText('Zoë');

    // The launcher is the identity authority — the injected name must not be
    // persisted as the user's own typed name.
    expect(await controller.evaluate(() => localStorage.getItem('stacker_player_name'))).toBeNull();

    // History stays untouched (pushState neutralized), so the settings
    // modal's Done button must close it directly instead of via history.back.
    expect(await controller.evaluate(() => history.state)).toBeNull();
    await controller.click('#lobby-settings-btn');
    await expect(controller.locator('#settings-overlay')).toBeVisible();
    await controller.click('#settings-close');
    await expect(controller.locator('#settings-overlay')).toBeHidden();

    // Live rename from the shell propagates to controller UI and display.
    await controller.evaluate(() => window.CouchGames.setName('Maxi'));
    await expect(controller.locator('#player-identity-name')).toHaveText('Maxi');
    await expect(page.locator('#player-list')).toContainText('Maxi');

    // Display navigating away broadcasts DISPLAY_CLOSED → terminal end goes
    // to the launcher bridge, with no navigation off the controller page.
    await page.goto('about:blank');
    await controller.waitForFunction(() => window.__cgEnded.length > 0, null, { timeout: 10000 });
    expect(await controller.evaluate(() => window.__cgEnded)).toEqual(['game_ended']);
    expect(controller.url()).toContain(`/${roomCode}`);
  });

  test('cg-accent-color meta tracks the player color (CONTRACT §4)', async ({ page, context }) => {
    const { roomCode } = await createRoom(page);
    const controller = await joinCouchController(context, roomCode, 'Iris');
    await controller.waitForSelector('#player-identity:not(.hidden)', { timeout: 10000 });

    const accentMeta = () => controller.evaluate(() =>
      document.querySelector('meta[name="cg-accent-color"]').getAttribute('content'));
    // The meta and the body's --player-color read from the same PLAYER_COLORS
    // entry, so a confirmed color always leaves them exactly equal.
    const metaMatchesPlayerColor = () => controller.evaluate(() => {
      const meta = document.querySelector('meta[name="cg-accent-color"]').getAttribute('content');
      const playerColor = getComputedStyle(document.body).getPropertyValue('--player-color').trim();
      return !!playerColor && meta === playerColor;
    });

    // After WELCOME assigns a color, the accent hint reflects it.
    await expect.poll(metaMatchesPlayerColor).toBe(true);
    const before = await accentMeta();

    // Picking a different swatch round-trips through the display (SET_COLOR →
    // LOBBY_UPDATE) and the meta follows the new color.
    await controller.click('#identity-trigger');
    await controller.waitForSelector('#color-picker-overlay:not(.hidden)');
    await controller.click('.rose-cell--center');

    await expect.poll(accentMeta).not.toBe(before);
    await expect.poll(metaMatchesPlayerColor).toBe(true);
  });

  test('unknown room surfaces room_not_found through gameEnded', async ({ context }) => {
    const controller = await context.newPage();
    await controller.addInitScript(() => {
      window.__cgEnded = [];
      window.CouchGamesHost = {
        gameEnded: (reason) => window.__cgEnded.push(reason),
      };
    });
    await fakeRoomNotFound(controller);
    await controller.goto('/ZZZZ?test=1&cgv=1&cgName=Ada');
    await controller.waitForFunction(() => window.__cgEnded.length > 0, null, { timeout: 10000 });
    expect(await controller.evaluate(() => window.__cgEnded)).toEqual(['room_not_found']);
    expect(controller.url()).toContain('/ZZZZ');
  });

  test('without the host bridge, ?cgv=1 falls back to the normal web bail', async ({ context }) => {
    const controller = await context.newPage();
    await fakeRoomNotFound(controller);
    await controller.goto('/ZZZZ?test=1&cgv=1&cgName=Ada');
    await controller.waitForURL(/\?bail=room_not_found/, { timeout: 10000 });
  });
});
