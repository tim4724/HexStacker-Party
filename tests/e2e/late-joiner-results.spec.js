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

// A mid-game joiner sat out the round, so the engine's results omit them (it's
// built from playerIds). At game-end the display appends them to results.results
// flagged newPlayer before broadcasting GAME_END, so every screen renders a
// "New player" row (no rank, no stats) rather than dropping them from the board.
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

    // A player tops out → results broadcast reaches every screen.
    await bob.waitForSelector('#gameover-screen:not(.hidden)', { timeout: 60000 });
    await alice.waitForSelector('#gameover-screen:not(.hidden)', { timeout: 60000 });
    await page.waitForSelector('#results-screen:not(.hidden)', { timeout: 60000 });

    const readRows = () =>
      [...document.querySelectorAll('#results-list .result-row')].map((r) => ({
        joining: r.classList.contains('result-row--joining'),
        isMe: r.classList.contains('is-me'),
        name: (r.querySelector('.result-name') || {}).textContent || '',
        rank: (r.querySelector('.result-rank') || {}).textContent || '',
        statsText: [...r.querySelectorAll('.result-stats span')].map((s) => s.textContent).join(' '),
      }));

    // The "New player" row shows on every screen: the late joiner's own
    // controller, a participant's controller, and the display.
    const bobRows = await bob.evaluate(readRows);
    const aliceRows = await alice.evaluate(readRows);
    const displayRows = await page.evaluate(readRows);

    for (const [label, rows] of [['bob', bobRows], ['alice', aliceRows], ['display', displayRows]]) {
      // Two ranked participants with lines/level stats.
      const ranked = rows.filter((r) => !r.joining);
      expect(ranked.map((r) => r.name).sort(), label).toEqual(['Alice', 'Carol']);
      expect(ranked.every((r) => /^[12]$/.test(r.rank)), label).toBe(true);

      // Exactly one "New player" row for Bob: no rank (dash), status label
      // instead of lines/level stats.
      const joining = rows.filter((r) => r.joining);
      expect(joining, label).toHaveLength(1);
      expect(joining[0].name, label).toBe('Bob');
      expect(joining[0].statsText, label).toBe('New player');
      expect(joining[0].rank, label).toBe('–');
    }

    // is-me highlight tracks the local player: Bob's joining row is is-me on
    // his controller but not Alice's, and Alice's ranked row is is-me on hers.
    expect(bobRows.find((r) => r.joining).isMe).toBe(true);
    expect(aliceRows.find((r) => r.joining).isMe).toBe(false);
    expect(aliceRows.find((r) => r.name === 'Alice').isMe).toBe(true);
  });
});
