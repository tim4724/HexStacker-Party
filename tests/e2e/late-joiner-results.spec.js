const { test, expect } = require('@playwright/test');
const {
  createRoom,
  joinController,
  waitForDisplayPlayers,
  waitForDisplayGame,
  waitForFont,
} = require('./helpers');

// A controller that joins after the game has already started. The display
// holds it out of the active round (it's never added to playerIds), so it
// sits on the "game in progress" waiting screen until the round ends.
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
    const waiting = document.getElementById('waiting-action-text');
    return waiting && waiting.textContent.length > 0;
  }, null, { timeout: 15000 });
  return page;
}

// A mid-game joiner sat out the round, so they never appear in the results
// payload. Rather than land them on a board where they don't exist, their own
// controller injects a "New player" row for themselves (no rank, no stats).
test.describe('Late-joiner results row', () => {
  test.setTimeout(90000);

  test('mid-game joiner sees a "New player" row on the results screen', async ({ page, context }) => {
    const { roomCode } = await createRoom(page);

    // Two real players so the results list is ranked (multiplayer layout).
    const alice = await joinController(context, roomCode, 'Alice');
    await waitForDisplayPlayers(page, 1);
    const carol = await joinController(context, roomCode, 'Carol');
    await waitForDisplayPlayers(page, 2);

    // Start at a high level so idle stacking tops a player out (ending the
    // round) within seconds. Host (Alice) owns the level control.
    await alice.evaluate(() => {
      const plus = document.getElementById('level-plus-btn');
      for (let i = 0; i < 14; i++) plus.click();
    });
    await alice.waitForTimeout(200);

    await alice.click('#start-btn');
    await waitForDisplayGame(page);

    // Bob joins mid-game (held out of the active round). joinMidGame already
    // waits for the "game in progress" waiting banner, confirming he's parked.
    const bob = await joinMidGame(context, roomCode, 'Bob');

    // A player tops out → results broadcast reaches Bob's waiting controller.
    await bob.waitForSelector('#gameover-screen:not(.hidden)', { timeout: 60000 });

    const rows = await bob.evaluate(() => {
      return [...document.querySelectorAll('#results-list .result-row')].map((r) => ({
        joining: r.classList.contains('result-row--joining'),
        isMe: r.classList.contains('is-me'),
        name: (r.querySelector('.result-name') || {}).textContent || '',
        rank: (r.querySelector('.result-rank') || {}).textContent || '',
        statsText: [...r.querySelectorAll('.result-stats span')].map((s) => s.textContent).join(' '),
      }));
    });

    // The two players who actually played are ranked with lines/level stats.
    const ranked = rows.filter((r) => !r.joining);
    expect(ranked).toHaveLength(2);
    expect(ranked.map((r) => r.name).sort()).toEqual(['Alice', 'Carol']);
    expect(ranked.every((r) => /^[12]$/.test(r.rank))).toBe(true);

    // Bob's own row: the injected "New player" row, highlighted as is-me,
    // with the status label instead of lines/level stats and a dash for rank.
    const joiningRows = rows.filter((r) => r.joining);
    expect(joiningRows).toHaveLength(1);
    const bobRow = joiningRows[0];
    expect(bobRow.name).toBe('Bob');
    expect(bobRow.isMe).toBe(true);
    expect(bobRow.statsText).toBe('New player');
    expect(bobRow.rank).toBe('–');
  });
});
