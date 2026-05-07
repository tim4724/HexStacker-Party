// Clip A — Lobby reveal (~3.4s).
// Open with the display showing only the bg color + falling-piece
// background (welcomeBg started naturally on display.js init), THEN fade
// the lobby UI in, THEN incrementally pop players + their phones in,
// THEN fade the caption, THEN press START.

const NAMES = ['Emma', 'Jake', 'Sofia', 'Liam'];
const STAGGER = 240;
const PLAYER_COUNT = 4;

// Stage hides the lobby UI before the screencast starts so frame 0 of
// the recording is just the background. The fade is driven by run().
// `transition: none` prevents the opacity:1→0 change from animating —
// otherwise the lobby visibly fades OUT during the staging window before
// our intended fade IN ever runs.
export async function stage({ display }) {
  const lobby = display.document.getElementById('lobby-screen');
  if (lobby) {
    lobby.style.transition = 'none';
    lobby.style.opacity = '0';
    // Force a reflow so the no-transition opacity=0 commits before the
    // run() phase swaps the transition back in for the fade-in.
    void lobby.offsetWidth;
  }
  // Make sure welcomeBg is animating already by the time we start
  // recording so the very first captured frame already shows pieces
  // mid-flight (no fresh-start "first piece appears" tell). _initPool
  // spawns every piece ABOVE the viewport (y < 0) so they fall in over
  // several seconds — for the ad open we want them ALREADY spread, so
  // we randomise each piece's y across the visible viewport once.
  if (display.welcomeBg) {
    display.welcomeBg.start();
    const bg = display.welcomeBg;
    const h = (bg.h || display.innerHeight) - 40;
    if (Array.isArray(bg.pool)) {
      for (const p of bg.pool) {
        p.y = Math.random() * h;
      }
    }
  }
}

export async function run({ display, phones }) {
  const lobby = display.document.getElementById('lobby-screen');
  const startBtn = display.document.getElementById('start-btn');
  const caption = document.getElementById('lobby-caption');

  const FADE_AT = 250;            // background-only beat before lobby appears
  const PLAYERS_AT = FADE_AT + 700;
  const CAPTION_AT = PLAYERS_AT + STAGGER * 2;

  setTimeout(() => {
    if (!lobby) return;
    lobby.style.transition = 'opacity 600ms ease-out';
    // Force layout flush so the transition definition lands BEFORE the
    // opacity change — without this, both inline-style writes commit in
    // one tick and the browser skips the transition.
    void lobby.offsetWidth;
    lobby.style.opacity = '1';
  }, FADE_AT);

  // Pop players in one-by-one. Each addPlayers call updates the lobby card
  // grid (renders the new player card with a CSS keyframe in the live
  // game UI) and the phone slides in alongside it.
  for (let i = 0; i < PLAYER_COUNT; i++) {
    const slot = i;
    setTimeout(() => {
      display.__TEST__.addPlayers([{ id: `adclip-p${slot}`, name: NAMES[slot], slot, level: 1 }]);
      phones[slot].wrapper.classList.add('in');
    }, PLAYERS_AT + STAGGER * i);
  }

  if (caption) {
    setTimeout(() => caption.classList.add('in'), CAPTION_AT);
  }

  // Simulate a press on START once all players are in. We don't fire the
  // real click handler (it would start the real game inside the iframe);
  // we just toggle a class that mimics the :active visual.
  const lastPlayerAt = PLAYERS_AT + STAGGER * (PLAYER_COUNT - 1);
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
