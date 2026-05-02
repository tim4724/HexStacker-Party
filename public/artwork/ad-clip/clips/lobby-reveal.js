// Clip A — Lobby reveal (~2.5s).
// Display loaded with empty lobby (?scenario=lobby&players=0). The clip
// pops players + their phones in one-by-one, fades the caption in, then
// simulates a press on the START button before cutting to gameplay.

const NAMES = ['Emma', 'Jake', 'Sofia', 'Liam'];
const STAGGER = 220;
const PLAYER_COUNT = 4;

export async function run({ display, phones }) {
  const startBtn = display.document.getElementById('start-btn');

  // Pop players in one-by-one. Each addPlayers updates the lobby card grid
  // (renders the new player card with a CSS keyframe defined by the live
  // game UI) and the phone slides in alongside it.
  for (let i = 0; i < PLAYER_COUNT; i++) {
    const slot = i;
    setTimeout(() => {
      try {
        display.__TEST__.addPlayers([{ id: `adclip-p${slot}`, name: NAMES[slot], slot, level: 1 }]);
      } catch (_) {}
      phones[slot].wrapper.classList.add('in');
    }, 80 + STAGGER * i);
  }

  // Caption fades in after the second player lands so the QR + first
  // cards have a beat to read first.
  const caption = document.getElementById('lobby-caption');
  if (caption) {
    setTimeout(() => caption.classList.add('in'), 80 + STAGGER * 2);
  }

  // Simulate a press on START once all players are in. We don't fire the
  // real click handler (it would start the real game inside the iframe);
  // we just toggle a class that mimics the :active visual.
  const lastPlayerAt = 80 + STAGGER * (PLAYER_COUNT - 1);
  const pressAt = lastPlayerAt + 1100;
  setTimeout(() => {
    if (!startBtn) return;
    startBtn.classList.add('adclip-pressed');
    setTimeout(() => startBtn.classList.remove('adclip-pressed'), 220);
  }, pressAt);

  await wait(pressAt + 480);
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
