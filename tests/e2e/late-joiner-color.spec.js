const { test, expect } = require('@playwright/test');
const {
  createRoom,
  joinController,
  waitForDisplayPlayers,
  waitForDisplayGame,
  waitForFont,
} = require('./helpers');

async function joinMidGame(context, roomCode, name) {
  const page = await context.newPage();
  await page.addInitScript((rc) => {
    var key = '_stacker_cleared_' + rc;
    if (!sessionStorage.getItem(key)) {
      localStorage.removeItem('clientId_' + rc);
      sessionStorage.setItem(key, '1');
    }
    // simulate a previous session where this user picked blue (idx 5)
    localStorage.setItem('stacker_color_index', '5');
  }, roomCode);
  await page.goto(`/${roomCode}?test=1`);
  await waitForFont(page);
  await page.fill('#name-input', name);
  await page.click('#name-join-btn');
  await page.waitForFunction(() => {
    const waiting = document.getElementById('waiting-action-text');
    return waiting && waiting.textContent.length > 0;
  }, null, { timeout: 15000 });
  return page;
}

test.describe('Late-joiner settings color', () => {
  test.setTimeout(60000);

  test('settings overlay shows assigned color, not stale persisted color', async ({ page, context }) => {
    const { roomCode } = await createRoom(page);
    // First player picks blue (idx 5)
    const alice = await joinController(context, roomCode, 'Alice');
    await waitForDisplayPlayers(page, 1);
    await alice.evaluate(() => sendToDisplay(MSG.SET_COLOR, { colorIndex: 5 }));
    await alice.waitForFunction(() => playerColorIndex === 5);

    // Start game
    await alice.click('#start-btn');
    await waitForDisplayGame(page);

    // Bob late-joins; localStorage pretends his last session was blue too
    const bob = await joinMidGame(context, roomCode, 'Bob');

    // He should be assigned red (idx 0) since blue is taken
    const bobColor = await bob.evaluate(() => ({
      idx: playerColorIndex,
      color: playerColor,
      bodyVar: getComputedStyle(document.body).getPropertyValue('--player-color').trim(),
      bodyInline: document.body.style.getPropertyValue('--player-color')
    }));
    console.log('Bob color state:', bobColor);
    expect(bobColor.idx).toBe(0);
    expect(bobColor.color.toUpperCase()).toBe('#FF6B6B');

    // Open settings
    await bob.evaluate(() => openSettings());
    await bob.waitForSelector('#settings-overlay:not(.hidden)');

    const settingsState = await bob.evaluate(() => {
      const sw = document.querySelector('.settings-switch[aria-checked="true"]');
      const seg = document.querySelector('.settings-segmented__btn[aria-checked="true"]');
      return {
        bodyPlayerColor: getComputedStyle(document.body).getPropertyValue('--player-color').trim(),
        bodyInline: document.body.style.getPropertyValue('--player-color'),
        switchBg: sw ? getComputedStyle(sw).backgroundColor : null,
        segBg: seg ? getComputedStyle(seg).backgroundColor : null
      };
    });
    console.log('Settings state:', settingsState);
    // Body should have red, not blue
    expect(settingsState.bodyPlayerColor.toUpperCase()).toBe('#FF6B6B');
    // Selected switch should be RED (255, 107, 107), not BLUE (91, 127, 255)
    expect(settingsState.switchBg).toBe('rgb(255, 107, 107)');
  });

  // Reproduces the AirConsole-mode race: persistent storage shim hydrates
  // AFTER WELCOME, so controller-airconsole's onLoad re-invokes
  // captureSessionColorIndex() which used to override the (correct)
  // display-assigned --player-color with the previous-session's persisted one.
  // Simulated in web mode by manually re-calling captureSessionColorIndex
  // after the late-join WELCOME has settled.
  test('re-running captureSessionColorIndex after WELCOME does not override assigned color', async ({ page, context }) => {
    const { roomCode } = await createRoom(page);
    const alice = await joinController(context, roomCode, 'Alice');
    await waitForDisplayPlayers(page, 1);
    await alice.evaluate(() => sendToDisplay(MSG.SET_COLOR, { colorIndex: 5 }));
    await alice.waitForFunction(() => playerColorIndex === 5);
    await alice.click('#start-btn');
    await waitForDisplayGame(page);

    const bob = await joinMidGame(context, roomCode, 'Bob');
    await bob.waitForFunction(() => playerColorIndex === 0);

    // Simulate AC onLoad firing after WELCOME — this is where the bug lives.
    const after = await bob.evaluate(() => {
      captureSessionColorIndex();
      return {
        bodyVar: getComputedStyle(document.body).getPropertyValue('--player-color').trim(),
        playerColor,
        playerColorIndex
      };
    });
    expect(after.bodyVar.toUpperCase()).toBe('#FF6B6B');
    expect(after.playerColorIndex).toBe(0);
  });
});
