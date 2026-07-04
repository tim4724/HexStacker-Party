// @ts-check
const { test, expect } = require('@playwright/test');
const {
  createRoom,
  joinController,
  waitForDisplayPlayers,
  waitForDisplayGame,
  waitForFont,
} = require('./helpers');

/**
 * Join a controller mid-game. Unlike joinController(), waits for either the
 * game screen OR lobby (late joiner waiting screen) to appear.
 */
async function joinMidGame(context, roomCode, name) {
  const page = await context.newPage();
  await page.addInitScript((rc) => {
    var key = '_stacker_cleared_' + rc;
    if (!sessionStorage.getItem(key)) {
      localStorage.removeItem('clientId_' + rc);
      sessionStorage.setItem(key, '1');
    }
  }, roomCode);
  await page.goto(`/${roomCode}?test=1`);
  await waitForFont(page);
  await page.fill('#name-input', name);
  await page.click('#name-join-btn');
  await page.waitForFunction(() => {
    const game = document.getElementById('game-screen');
    const lobby = document.getElementById('player-identity');
    const waiting = document.getElementById('waiting-action-text');
    return (game && !game.classList.contains('hidden')) ||
           (lobby && !lobby.classList.contains('hidden')) ||
           (waiting && waiting.textContent.length > 0);
  }, null, { timeout: 15000 });
  return page;
}

async function scanReconnectClaim(context, roomCode, claim) {
  const page = await context.newPage();
  await page.goto(`/${roomCode}?test=1&claim=${encodeURIComponent(claim)}`);
  await waitForFont(page);
  await page.waitForSelector('#game-screen:not(.hidden)', { timeout: 15000 });
  await page.waitForFunction(() => typeof waitingForNextGame !== 'undefined' && waitingForNextGame === false);
  return page;
}

test.describe('Reconnection', () => {
  test.setTimeout(60000);

  test('display auto-pauses when controller disconnects during game', async ({ page, context }) => {
    const { roomCode } = await createRoom(page);
    const controller = await joinController(context, roomCode, 'Alice');

    await waitForDisplayPlayers(page, 1);
    await controller.click('#start-btn');
    await waitForDisplayGame(page);

    // Close controller (simulates disconnect)
    await controller.close();

    // Display should auto-pause
    await page.waitForFunction(() => {
      return typeof autoPaused !== 'undefined' && autoPaused === true;
    }, null, { timeout: 10000 });

    const isPaused = await page.evaluate(() => paused);
    expect(isPaused).toBe(true);

    await expect(page.locator('#pause-btn')).toBeEnabled();
    await expect(page.locator('#game-toolbar')).not.toHaveClass(/toolbar-autohide/);
    await page.click('#pause-btn');
    await expect(page.locator('#pause-overlay')).toBeVisible();
    await expect(page.locator('#pause-continue-btn')).toBeEnabled();
    await expect(page.locator('#pause-newgame-btn')).toBeVisible();

    await page.click('#pause-continue-btn');
    await expect(page.locator('#pause-overlay')).toBeHidden();
    await expect(page.locator('#game-toolbar')).toBeVisible();
    expect(await page.evaluate(() => paused)).toBe(true);
    expect(await page.evaluate(() => autoPaused)).toBe(true);
    expect(await page.evaluate(() => disconnectedQRs.size)).toBe(1);
  });

  test('manual pause then all players disconnect hides the stranded overlay', async ({ page, context }) => {
    const { roomCode } = await createRoom(page);
    const controller = await joinController(context, roomCode, 'Alice');

    await waitForDisplayPlayers(page, 1);
    await controller.click('#start-btn');
    await waitForDisplayGame(page);

    // Host manually pauses WHILE the player is still connected: overlay up,
    // manual (not auto) pause. Nudge the cursor first so the toolbar isn't
    // auto-hidden behind the game canvas.
    await page.mouse.move(10, 10);
    await page.click('#pause-btn');
    await expect(page.locator('#pause-overlay')).toBeVisible();
    expect(await page.evaluate(() => paused)).toBe(true);
    expect(await page.evaluate(() => autoPaused)).toBe(false);

    // Now the sole player disconnects. The manual pause must convert into a
    // silent auto-pause and the stranded overlay must hide again (Continue is
    // gated shut while everyone is gone, so it could otherwise never be
    // dismissed — the reported bug).
    await controller.close();

    await expect(page.locator('#pause-overlay')).toBeHidden();
    expect(await page.evaluate(() => paused)).toBe(true);
    expect(await page.evaluate(() => autoPaused)).toBe(true);
    expect(await page.evaluate(() => disconnectedQRs.size)).toBe(1);
  });

  test('single player: controller disconnecting during countdown shows disconnect overlay', async ({ page, context }) => {
    const { roomCode } = await createRoom(page);
    const controller = await joinController(context, roomCode, 'Alice');

    await waitForDisplayPlayers(page, 1);
    await controller.click('#start-btn');

    // Wait until the display is mid-countdown, then drop the sole controller.
    // This lands the game in PLAYING already auto-paused (no live controllers).
    await page.waitForFunction(() => typeof roomState !== 'undefined' && roomState === ROOM_STATE.COUNTDOWN);
    await controller.close();

    // The game silently auto-pauses the instant PLAYING begins.
    await page.waitForFunction(() => {
      return typeof autoPaused !== 'undefined' && autoPaused === true;
    }, null, { timeout: 10000 });

    // Regression: the render loop must still capture a snapshot so the boards
    // (and the disconnect QR overlay) render, instead of staying on the empty
    // pre-game boards because gameState was never populated.
    await page.waitForFunction(() => typeof gameState !== 'undefined' && gameState !== null, null, { timeout: 5000 });
    expect(await page.evaluate(() => paused)).toBe(true);
    expect(await page.evaluate(() => disconnectedQRs.size)).toBe(1);
  });

  test('two players: both disconnecting during countdown shows disconnect overlays', async ({ page, context }) => {
    const { roomCode } = await createRoom(page);
    const c1 = await joinController(context, roomCode, 'Alice');
    const c2 = await joinController(context, roomCode, 'Bob');

    await waitForDisplayPlayers(page, 2);
    await c1.click('#start-btn');

    // Drop BOTH controllers mid-countdown. Once every participant is gone (and
    // there are no late joiners), PLAYING begins already auto-paused: the same
    // all-disconnected path as single player, just needing two drops.
    await page.waitForFunction(() => typeof roomState !== 'undefined' && roomState === ROOM_STATE.COUNTDOWN);
    await Promise.all([c1.close(), c2.close()]);

    await page.waitForFunction(() => {
      return typeof autoPaused !== 'undefined' && autoPaused === true;
    }, null, { timeout: 10000 });

    // Regression: gameState must be primed so both boards render their
    // disconnect QR overlays instead of empty pre-game boards.
    await page.waitForFunction(() => typeof gameState !== 'undefined' && gameState !== null, null, { timeout: 5000 });
    expect(await page.evaluate(() => paused)).toBe(true);
    expect(await page.evaluate(() => disconnectedQRs.size)).toBe(2);
  });

  test('display reconnect overlay shows when relay connection drops', async ({ page, context }) => {
    // Intercept the relay WebSocket so we can force-close it
    let serverWs;
    await page.routeWebSocket(/ws\.hexstacker\.com/, (ws) => {
      const server = ws.connectToServer();
      serverWs = { client: ws, server };

      ws.onMessage((msg) => server.send(msg));
      server.onMessage((msg) => ws.send(msg));
    });

    const { roomCode } = await createRoom(page);
    const controller = await joinController(context, roomCode, 'Alice');

    await waitForDisplayPlayers(page, 1);
    await controller.click('#start-btn');
    await waitForDisplayGame(page);

    // Force close the display's relay connection from server side
    serverWs.server.close();

    // Reconnect overlay should appear
    await page.waitForSelector('#reconnect-overlay:not(.hidden)', { timeout: 15000 });
  });

  test('two-player game: one disconnect does not end game', async ({ page, context }) => {
    const { roomCode } = await createRoom(page);
    const c1 = await joinController(context, roomCode, 'Alice');
    const c2 = await joinController(context, roomCode, 'Bob');

    await waitForDisplayPlayers(page, 2);
    await c1.click('#start-btn');
    await waitForDisplayGame(page);

    // Close one controller
    await c1.close();

    // Game should still be running (not ended) after a brief settle period
    const endedEarly = await page.waitForFunction(
      () => typeof roomState !== 'undefined' && roomState === 'results',
      null, { timeout: 2000 }
    ).then(() => true).catch(() => false);
    expect(endedEarly).toBe(false);
  });

  test('new controller joining mid-game is treated as late joiner', async ({ page, context }) => {
    const { roomCode } = await createRoom(page);
    const controller = await joinController(context, roomCode, 'Alice');

    await waitForDisplayPlayers(page, 1);
    await controller.click('#start-btn');
    await waitForDisplayGame(page);

    // A fresh page load creates a new clientId at the relay, so the display
    // correctly treats this as a new player (late joiner), not a reconnect.
    const lateComer = await joinMidGame(context, roomCode, 'Bob');

    // Late joiner should see "game in progress" waiting message
    await lateComer.waitForFunction(() => {
      const el = document.getElementById('waiting-action-text');
      return el && el.textContent.length > 0 && !el.classList.contains('hidden');
    }, null, { timeout: 10000 });
    const waitingMsg = await lateComer.evaluate(() => {
      return document.getElementById('waiting-action-text').textContent;
    });
    expect(waitingMsg.length).toBeGreaterThan(0);
  });

  test('host handoff: new host is promoted when original host disconnects mid-game', async ({ page, context }) => {
    const { roomCode } = await createRoom(page);
    const c1 = await joinController(context, roomCode, 'Alice');
    const c2 = await joinController(context, roomCode, 'Bob');

    await waitForDisplayPlayers(page, 2);

    // Sanity: Alice is host (lowest-slot controller), Bob is not.
    await c1.waitForFunction(() => typeof isHost !== 'undefined' && isHost === true, null, { timeout: 5000 });
    await c2.waitForFunction(() => typeof isHost !== 'undefined' && isHost === false, null, { timeout: 5000 });

    await c1.click('#start-btn');
    await waitForDisplayGame(page);

    // Alice (host) drops out mid-game.
    const aliceId = await c1.evaluate(() => peerIndex);
    await c1.close();

    // Display should flag Alice as disconnected, and getHostPeerIndex() should
    // hand off to Bob (lowest-slot among connected playerOrder members).
    await page.waitForFunction((id) => {
      return typeof disconnectedQRs !== 'undefined'
          && disconnectedQRs.has(id)
          && typeof getHostPeerIndex === 'function'
          && getHostPeerIndex() !== id;
    }, aliceId, { timeout: 10000 });

    // Bob's controller should receive the LOBBY_UPDATE and flip isHost.
    await c2.waitForFunction(() => typeof isHost !== 'undefined' && isHost === true, null, { timeout: 5000 });
  });

  test('display shows disconnected QR overlay for missing player', async ({ page, context }) => {
    const { roomCode } = await createRoom(page);
    const c1 = await joinController(context, roomCode, 'Alice');
    const c2 = await joinController(context, roomCode, 'Bob');

    await waitForDisplayPlayers(page, 2);
    await c1.click('#start-btn');
    await waitForDisplayGame(page);

    // Close one controller
    await c1.close();

    // Display should have a disconnected QR for the lost player
    await page.waitForFunction(() => {
      return typeof disconnectedQRs !== 'undefined' && disconnectedQRs.size > 0;
    }, null, { timeout: 10000 });

    const disconnectedCount = await page.evaluate(() => disconnectedQRs.size);
    expect(disconnectedCount).toBe(1);
  });

  test('same phone scanning reconnect QR keeps stored relay client id', async ({ page, context }) => {
    const { roomCode } = await createRoom(page);
    const c1 = await joinController(context, roomCode, 'Alice');

    await waitForDisplayPlayers(page, 1);
    await c1.click('#start-btn');
    await waitForDisplayGame(page);

    const aliceId = await c1.evaluate(() => peerIndex);
    const storedClientId = await c1.evaluate((rc) => localStorage.getItem('clientId_' + rc), roomCode);
    await c1.close();

    await page.waitForFunction((id) => {
      return typeof disconnectedQRs !== 'undefined'
          && disconnectedQRs.has(id);
    }, aliceId, { timeout: 10000 });
    const claim = String(aliceId);

    const reconnected = await scanReconnectClaim(context, roomCode, claim);
    await reconnected.waitForFunction((expected) => peerIndex === expected, aliceId, { timeout: 5000 });
    const reconnectedClientId = await reconnected.evaluate(() => clientId);

    expect(reconnectedClientId).toBe(storedClientId);
    expect(await reconnected.evaluate(() => waitingForNextGame)).toBe(false);
    await page.waitForFunction((id) => {
      return typeof disconnectedQRs !== 'undefined' && !disconnectedQRs.has(id);
    }, aliceId, { timeout: 5000 });
  });

  test('different phone scanning reconnect QR claims disconnected player without old client id', async ({ page, context, browser }) => {
    const { roomCode } = await createRoom(page);
    const c1 = await joinController(context, roomCode, 'Alice');

    await waitForDisplayPlayers(page, 1);
    await c1.click('#start-btn');
    await waitForDisplayGame(page);

    const aliceId = await c1.evaluate(() => peerIndex);
    const oldClientId = await c1.evaluate(() => clientId);
    await c1.close();

    await page.waitForFunction((id) => {
      return typeof disconnectedQRs !== 'undefined'
          && disconnectedQRs.has(id);
    }, aliceId, { timeout: 10000 });
    const claim = String(aliceId);

    const freshContext = await browser.newContext();
    try {
      const replacement = await scanReconnectClaim(freshContext, roomCode, claim);
      const replacementId = await replacement.evaluate(() => peerIndex);
      const replacementClientId = await replacement.evaluate(() => clientId);

      expect(replacementId).not.toBe(aliceId);
      expect(replacementClientId).not.toBe(oldClientId);
      expect(await replacement.evaluate(() => playerName)).toBe('Alice');
      expect(await replacement.evaluate(() => waitingForNextGame)).toBe(false);

      await page.waitForFunction(({ oldId, newId }) => {
        return typeof disconnectedQRs !== 'undefined'
            && !disconnectedQRs.has(oldId)
            && typeof playerOrder !== 'undefined'
            && playerOrder.indexOf(oldId) < 0
            && playerOrder.indexOf(newId) >= 0
            && typeof displayGame !== 'undefined'
            && displayGame
            && displayGame.playerIds.indexOf(newId) >= 0
            && displayGame.playerIds.indexOf(oldId) < 0;
      }, { oldId: aliceId, newId: replacementId }, { timeout: 5000 });
    } finally {
      await freshContext.close();
    }
  });
});
