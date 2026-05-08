// Clip A — Lobby reveal (~3.4s).
// Open with the display showing only the bg color + falling-piece
// background (welcomeBg started naturally on display.js init), THEN fade
// the lobby UI in, THEN incrementally pop players in. The START button is
// hidden by composite.js so we don't simulate a press anymore — the clip
// just holds on the populated lobby until the cut to normal4p.

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

export async function run({ display }) {
  const lobby = display.document.getElementById('lobby-screen');

  const FADE_AT = 250;            // background-only beat before lobby appears
  const PLAYERS_AT = FADE_AT + 700;

  setTimeout(() => {
    if (!lobby) return;
    lobby.style.transition = 'opacity 600ms ease-out';
    // Force layout flush so the transition definition lands BEFORE the
    // opacity change — without this, both inline-style writes commit in
    // one tick and the browser skips the transition.
    void lobby.offsetWidth;
    lobby.style.opacity = '1';
  }, FADE_AT);

  // Pop players in one-by-one. Each addPlayers call renders a new player
  // card via the lobby's CSS keyframe.
  for (let i = 0; i < PLAYER_COUNT; i++) {
    const slot = i;
    setTimeout(() => {
      display.__TEST__.addPlayers([{ id: `adclip-p${slot}`, name: NAMES[slot], slot, level: 1 }]);
    }, PLAYERS_AT + STAGGER * i);
  }

  // Hold on the populated lobby for ~1.5s after the last player joins,
  // matching the original cadence so the next-clip xfade lines up.
  const lastPlayerAt = PLAYERS_AT + STAGGER * (PLAYER_COUNT - 1);
  await wait(lastPlayerAt + 1580);
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
