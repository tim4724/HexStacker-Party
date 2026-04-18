// @ts-check
const { test, expect } = require('@playwright/test');
const { createRoom, joinController, waitForDisplayPlayers } = require('./helpers');

/**
 * Stability tests: verify a display + controller pair stay connected to the
 * relay for a sustained period with no spontaneous reconnects or state drift.
 *
 * Tune the wall-clock duration with STABILITY_MS (default 30s for CI; bump
 * to e.g. 600000 for 10-min manual soak runs).
 */
const DURATION_MS = Number(process.env.STABILITY_MS || 30_000);
const SAMPLE_INTERVAL_MS = 2_000;

async function sampleDisplay(page) {
  return page.evaluate(() => ({
    connected: !!(window.party && window.party.connected),
    wsReadyState: window.party && window.party.ws ? window.party.ws.readyState : -1,
    reconnectAttempt: window.party ? window.party.reconnectAttempt : -1,
    roomCode: (document.querySelector('#join-url .join-url__code') || {}).textContent?.trim(),
    playerCount: document.querySelectorAll('#player-list .player-card:not(.empty)').length,
    reconnectOverlayHidden: document.getElementById('reconnect-overlay')?.classList.contains('hidden'),
    currentScreenId: document.querySelector('.screen:not(.hidden)')?.id,
  }));
}

async function sampleController(page) {
  return page.evaluate(() => ({
    connected: !!(window.party && window.party.connected),
    wsReadyState: window.party && window.party.ws ? window.party.ws.readyState : -1,
    reconnectAttempt: window.party ? window.party.reconnectAttempt : -1,
    reconnectOverlayHidden: document.getElementById('reconnect-overlay')?.classList.contains('hidden'),
    lobbyVisible: !document.getElementById('player-identity')?.classList.contains('hidden'),
  }));
}

test.describe('Stability', () => {
  // +60s slack for setup/teardown
  test.setTimeout(DURATION_MS + 60_000);

  test(`display + controller stay connected for ${DURATION_MS}ms`, async ({ page, context }) => {
    const { roomCode } = await createRoom(page);
    const controller = await joinController(context, roomCode, 'Alice');
    await waitForDisplayPlayers(page, 1);

    const start = Date.now();
    /** @type {Array<{t: number, display: any, controller: any}>} */
    const samples = [];

    while (Date.now() - start < DURATION_MS) {
      const [display, controllerState] = await Promise.all([
        sampleDisplay(page),
        sampleController(controller),
      ]);
      const t = Date.now() - start;
      samples.push({ t, display, controller: controllerState });

      // Fail fast on the first anomaly — quicker feedback than waiting to the end.
      expect(display.connected, `display disconnected at t=${t}ms`).toBe(true);
      expect(display.reconnectAttempt, `display reconnected at t=${t}ms`).toBe(0);
      expect(display.reconnectOverlayHidden, `display reconnect overlay visible at t=${t}ms`).toBe(true);
      expect(display.playerCount, `player card vanished at t=${t}ms`).toBe(1);
      expect(display.currentScreenId, `display left lobby at t=${t}ms`).toBe('lobby-screen');

      expect(controllerState.connected, `controller disconnected at t=${t}ms`).toBe(true);
      expect(controllerState.reconnectAttempt, `controller reconnected at t=${t}ms`).toBe(0);
      expect(controllerState.reconnectOverlayHidden, `controller reconnect overlay visible at t=${t}ms`).toBe(true);
      expect(controllerState.lobbyVisible, `controller lobby hidden at t=${t}ms`).toBe(true);

      await new Promise((r) => setTimeout(r, SAMPLE_INTERVAL_MS));
    }

    console.log(`[stability] ${samples.length} samples over ${Date.now() - start}ms; all passed`);
  });
});
