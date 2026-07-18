// Plain-logo finale — the brand wordmark on the dark composite backdrop.
//
// composite.css's `body.clip-logo` rules hide the display iframe and the
// phones; this module just toggles the title-card visibility and holds.
//
// All pacing here runs on ctx.waitScaled (game-time), not setTimeout
// (wall-clock), because this clip is time-scaled during capture: the card's
// 600ms CSS fade is slowed to match by composite.js's scaleCssAnimations, so
// the hold has to be slowed the same way or the clip would end mid-fade.

export async function stage() {
  // No DOM mutation — visibility is driven by run().
}

// Tail buffer between when run() returns and the screencast's last frame.
// Composite.js then waits another ~120ms after run() before flagging DONE,
// so the captured sequence covers the full configured duration.
const TAIL_MS = 100;

// Beat before the card fades up, so the cut from chaos8p lands first.
const FADE_DELAY_MS = 200;

export async function run({ titleCard, durationMs, waitScaled }) {
  titleCard.classList.remove('hidden');
  await waitScaled(FADE_DELAY_MS);
  titleCard.classList.add('in');
  // durationMs comes from variants.js via composite ctx — keeps the
  // hold-time coupled to the slot the variant allocated. Fallback for
  // older callers / direct loads.
  await waitScaled(Math.max(500, (durationMs || 6000) - FADE_DELAY_MS - TAIL_MS));
}
