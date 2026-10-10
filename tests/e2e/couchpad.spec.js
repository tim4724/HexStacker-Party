// @ts-check
const { test, expect } = require('@playwright/test');
const {
  createRoom,
  waitForControllerGame,
  waitForControllerResults,
  waitForDisplayGame,
  waitForDisplayPlayers,
  waitForFont,
} = require('./helpers');

/**
 * CouchPad Controller Contract against a stubbed launcher bridge
 * (window.CouchPadHost is the shell gate): the launcher's name replaces the
 * name screen, the lobby rename opens the launcher's sheet (editName), the X
 * buttons leave through leave(), and terminal session ends surface through
 * gameEnded(reason) instead of a navigation to the display root.
 */

// window.__cp.renameTo is what the next editName() resolves to (null = the
// player dismissed the sheet).
function hostStub(name) {
  window.__cp = { renameTo: null, edits: [], left: 0, ended: [], back: [], haptics: [] };
  window.CouchPadHost = {
    name,
    editName: () => {
      window.__cp.edits.push(getComputedStyle(document.documentElement).accentColor);
      const next = window.__cp.renameTo;
      if (next) window.CouchPadHost.name = next;
      return Promise.resolve(next);
    },
    leave: () => { window.__cp.left++; },
    gameEnded: (reason) => window.__cp.ended.push(reason),
    enableSystemBack: (on) => window.__cp.back.push(on),
    haptic: (primitive, scale) => window.__cp.haptics.push([primitive, scale]),
  };
}

async function joinCouchPadController(context, roomCode, name) {
  const page = await context.newPage();
  await page.addInitScript((rc) => localStorage.removeItem('clientId_' + rc), roomCode);
  await page.addInitScript(hostStub, name);
  await page.goto(`/${roomCode}?test=1`);
  await waitForFont(page);
  await page.waitForSelector('#player-identity:not(.hidden)', { timeout: 10000 });
  return page;
}

const cp = (page) => page.evaluate(() => window.__cp);

// Fabricate the relay's answer for a room that must not exist, so the test
// doesn't depend on production-relay state for the negative path: the HTTP
// probe a browser's name screen runs, and the socket the shell joins on.
async function fakeRoomNotFound(page) {
  await page.route(/\/room\/ZZZZ/, (route) => route.fulfill({ status: 404, body: '' }));
  await page.routeWebSocket(/ws\.hexstacker\.com/, (ws) => {
    ws.onMessage(() => {
      ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
    });
  });
}

test.describe('CouchPad shell contract', () => {
  test('joins as CouchPadHost.name, renames through editName, the X leaves', async ({ page, context }) => {
    const { roomCode } = await createRoom(page);
    const controller = await joinCouchPadController(context, roomCode, 'Zoë');

    // Name screen skipped: the launcher's name lands in the lobby directly.
    await expect(controller.locator('#player-identity-name')).toHaveText('Zoë');
    await expect(controller.locator('#name-screen')).toBeHidden();
    await waitForDisplayPlayers(page, 1);
    await expect(page.locator('#player-list')).toContainText('Zoë');

    // The launcher owns the name, so it must not be persisted as the
    // browser's typed name.
    expect(await controller.evaluate(() => localStorage.getItem('stacker_player_name'))).toBeNull();

    // The name on the card opens the launcher's sheet; a dismissal changes
    // nothing.
    await expect(controller.locator('#identity-trigger')).toHaveAttribute('aria-label', 'Change name');
    await controller.click('#identity-trigger');
    await expect.poll(async () => (await cp(controller)).edits.length).toBe(1);
    await expect(controller.locator('#player-identity-name')).toHaveText('Zoë');

    // The sheet's Save button takes the player's color from :root accent-color.
    const playerRgb = await controller.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.color = getComputedStyle(document.body).getPropertyValue('--player-color');
      document.body.appendChild(probe);
      const rgb = getComputedStyle(probe).color;
      probe.remove();
      return rgb;
    });
    expect((await cp(controller)).edits[0]).toBe(playerRgb);

    // A saved name reaches the display live.
    await controller.evaluate(() => { window.__cp.renameTo = 'Maxi'; });
    await controller.click('#identity-trigger');
    await expect(controller.locator('#player-identity-name')).toHaveText('Maxi');
    await expect(page.locator('#player-list')).toContainText('Maxi');

    // The launcher's leave button is an X, labelled as leaving.
    await expect(controller.locator('#lobby-leave-btn .leave-btn__close')).toBeVisible();
    await expect(controller.locator('#lobby-leave-btn .leave-btn__back')).toBeHidden();
    await expect(controller.locator('#lobby-leave-btn')).toHaveAttribute('aria-label', 'Leave Game');

    // Haptics go to the launcher as primitives: the X is a 'button' effect
    // (click 0.7) at the default Medium tier (x0.75). The X closes the web
    // view through the launcher and does nothing else.
    await controller.click('#lobby-leave-btn');
    expect((await cp(controller)).left).toBe(1);
    expect((await cp(controller)).haptics.at(-1)).toEqual(['click', 0.7 * 0.75]);
    expect(controller.url()).toContain(`/${roomCode}`);
  });

  test('display close → gameEnded', async ({ page, context }) => {
    const { roomCode } = await createRoom(page);
    const controller = await joinCouchPadController(context, roomCode, 'Iris');

    // Display navigating away tears the room down (close_room): the 4001
    // close is the controller's terminal end and goes to the launcher
    // bridge, with no navigation off the controller page.
    await page.goto('about:blank');
    await controller.waitForFunction(() => window.__cp.ended.length > 0, null, { timeout: 10000 });
    expect((await cp(controller)).ended).toEqual(['game_ended']);
    expect(controller.url()).toContain(`/${roomCode}`);
  });

  test('system back arms per screen and consumes dialog dismissals', async ({ page, context }) => {
    test.setTimeout(90000);
    const { roomCode } = await createRoom(page);
    const controller = await joinCouchPadController(context, roomCode, 'Nils');

    const armed = () => controller.evaluate(() => window.__cp.back[window.__cp.back.length - 1]);
    const back = () => controller.evaluate(() => window.CouchPad.back());

    // Lobby: armed with nothing to close, so the gesture falls through to the
    // launcher and leaves the game, the same exit as the X.
    await expect.poll(armed).toBe(true);
    expect(await back()).toBe(false);

    // Dialogs answer the gesture themselves and the player stays in the room.
    await controller.click('#lobby-settings-btn');
    await expect(controller.locator('#settings-overlay')).toBeVisible();
    expect(await back()).toBe(true);
    await expect(controller.locator('#settings-overlay')).toBeHidden();

    // The colour picker fades out rather than unmounting (it keeps
    // `display: flex` while hidden), so its class is what "closed" means.
    await controller.click('#color-btn');
    await controller.waitForSelector('#color-picker-overlay:not(.hidden)');
    expect(await back()).toBe(true);
    await controller.waitForSelector('#color-picker-overlay.hidden');

    // Live game: disarmed, so the screen edges stay drag input. Level 15 tops
    // the solo player out quickly, which carries us to the results screen.
    await controller.evaluate(() => {
      const plus = document.getElementById('level-plus-btn');
      for (let i = 0; i < 14; i++) plus.click();
    });
    await expect(controller.locator('#level-display')).toHaveText('15');
    await controller.click('#start-btn');
    await waitForDisplayGame(page);
    await waitForControllerGame(controller);
    await expect.poll(armed).toBe(false);

    // Pause overlay: armed again, and back resumes the game like Continue.
    await controller.click('#pause-btn');
    await expect(controller.locator('#pause-overlay')).toBeVisible();
    await expect(controller.locator('#pause-leave-btn')).toBeVisible();
    await expect.poll(armed).toBe(true);
    expect(await back()).toBe(true);
    await expect(controller.locator('#pause-overlay')).toBeHidden();
    await expect.poll(armed).toBe(false);

    // Results: armed with nothing to close, like the lobby.
    await waitForControllerResults(controller);
    await expect.poll(armed).toBe(true);
    expect(await back()).toBe(false);

    // Arming costs the game its screen edges, so the launcher hears about it
    // only when the state actually flips, not on every snapshot that repaints
    // a screen. Consecutive duplicates would mean the sync is chattering.
    const calls = (await cp(controller)).back;
    expect(calls.filter((on, i) => i > 0 && on === calls[i - 1])).toEqual([]);
  });

  test('unknown room surfaces room_not_found through gameEnded', async ({ context }) => {
    const controller = await context.newPage();
    await controller.addInitScript(hostStub, 'Ada');
    await fakeRoomNotFound(controller);
    await controller.goto('/ZZZZ?test=1');
    await controller.waitForFunction(() => window.__cp.ended.length > 0, null, { timeout: 10000 });
    expect((await cp(controller)).ended).toEqual(['room_not_found']);
    expect(controller.url()).toContain('/ZZZZ');
  });

  test('without the host bridge, the normal web bail runs', async ({ context }) => {
    const controller = await context.newPage();
    await fakeRoomNotFound(controller);
    // Wait on the request, not the URL: the landing page strips ?bail= on
    // load, which can land before waitForURL attaches under CI timing.
    const bail = controller.waitForRequest(/\/\?bail=room_not_found$/, { timeout: 10000 });
    await controller.goto('/ZZZZ?test=1');
    await bail;
  });
});
