// Clip F — Winner / brand finale (~3s).
// Same visual approach as logo.js — brand wordmark centred on a clean dark
// backdrop — with the URL anchored at the bottom of the frame as a CTA.
// QR card and "Phones become controllers." tagline are dropped (composite
// CSS hides them via body.clip-winner rules).

// Tail buffer between when run() returns and the screencast's last frame.
// Composite.js then waits another ~120ms before flagging DONE, so the
// captured sequence covers the full configured duration.
const TAIL_MS = 100;

export async function stage() {
  // Nothing to pre-render — visibility is driven by run().
}

export async function run({ titleCard, durationMs }) {
  setTimeout(() => titleCard.classList.add('in'), 200);
  titleCard.classList.remove('hidden');
  // durationMs comes from variants.js via composite ctx — couples the
  // hold-time to the slot the variant allocated.
  await wait(Math.max(500, (durationMs || 3000) - TAIL_MS));
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
