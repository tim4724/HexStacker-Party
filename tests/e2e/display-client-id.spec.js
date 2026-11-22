// @ts-check
const { test, expect } = require('@playwright/test');
const { createRoom } = require('./helpers');
const { RELAY_URL } = require('../../public/shared/protocol.js');

/**
 * The display's relay clientId is slot 0's bearer secret: the relay hands slot 0
 * to any socket that joins with it and closes the incumbent with 4000. The room
 * code is on screen, so the id must be unguessable (it used to be the constant
 * 'display', which let anyone with the code take the display over), fresh for
 * every room, and re-presented on every rejoin of that room.
 */

const SECRET = /^display-[0-9a-f]{32}$/;

/** Proxy the display's relay socket, recording the frames each way. */
function interceptRelay(page, state) {
  return page.routeWebSocket(/ws\.hexstacker\.com/, (ws) => {
    const server = ws.connectToServer();
    state.links.push({ route: ws, server });
    ws.onMessage((m) => { state.sent.push(JSON.parse(String(m))); server.send(m); });
    server.onMessage((m) => { state.received.push(JSON.parse(String(m))); ws.send(m); });
  });
}

const ofType = (frames, type) => frames.filter((f) => f.type === type);

test.describe('Display relay clientId', () => {
  test('a stranger holding the room code cannot take slot 0, and a dropped display rejoins it', async ({ page }) => {
    const state = { links: [], sent: [], received: [] };
    await interceptRelay(page, state);
    const { roomCode } = await createRoom(page);

    const clientId = ofType(state.sent, 'create')[0].clientId;
    expect(clientId).toMatch(SECRET);

    // The takeover the constant allowed: join the room as 'display'.
    const instance = await page.evaluate(() => lastInstance);
    const stranger = new WebSocket(`${RELAY_URL}/${roomCode}?instance=${encodeURIComponent(instance)}`);
    const strangerJoined = new Promise((resolve, reject) => {
      stranger.onopen = () => stranger.send(JSON.stringify({ type: 'join', clientId: 'display', room: roomCode }));
      stranger.onmessage = (e) => { const f = JSON.parse(e.data); if (f.type === 'joined' || f.type === 'error') resolve(f); };
      stranger.onerror = reject;
    });
    try {
      const joined = await strangerJoined;
      expect(joined.type).toBe('joined');
      expect(joined.index).not.toBe(0);

      // The display kept its socket: no eviction, no reconnect.
      await page.waitForTimeout(1500);
      expect(state.links).toHaveLength(1);
      await expect(page.locator('#reconnect-overlay')).toBeHidden();

      // Our own drop still lands back on slot 0, with the same secret.
      state.links[0].server.close();
      await expect.poll(() => ofType(state.received, 'joined').length, { timeout: 15000 }).toBe(1);
      expect(ofType(state.sent, 'join')[0]).toMatchObject({ clientId, room: roomCode });
      expect(ofType(state.received, 'joined')[0].index).toBe(0);
      expect(ofType(state.sent, 'create')).toHaveLength(1);
    } finally {
      stranger.close();
    }
  });

  test('a fresh room gets a fresh clientId', async ({ page }) => {
    const state = { links: [], sent: [], received: [] };
    await interceptRelay(page, state);
    await createRoom(page);

    // 4001: the room is gone, so the display recovers into a new one.
    await state.links[0].route.close({ code: 4001, reason: 'room closed' });
    await expect.poll(() => ofType(state.sent, 'create').length, { timeout: 15000 }).toBe(2);

    const [first, second] = ofType(state.sent, 'create').map((f) => f.clientId);
    expect(first).toMatch(SECRET);
    expect(second).toMatch(SECRET);
    expect(second).not.toBe(first);
  });
});
