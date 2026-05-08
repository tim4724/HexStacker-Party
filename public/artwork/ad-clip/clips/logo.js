// Plain-logo finale — like winner.js but without the QR card or URL/tag
// copy. Just the brand wordmark on the dark composite backdrop. Used by
// the "clean" variant for placements where the QR + URL doesn't suit
// (e.g. embedded video where the viewer can't scan, or contexts that
// already have their own surrounding CTA).
//
// composite.css's `body.clip-logo` rules hide the iframe and the title-card
// QR/URL/tag elements; this module just toggles the title-card visibility.

export async function stage() {
  // No QR fetch, no DOM mutation — visibility is driven by run().
}

// Tail buffer between when run() returns and the screencast's last frame.
// Composite.js then waits another ~120ms after run() before flagging DONE,
// so the captured sequence covers the full configured duration.
const TAIL_MS = 100;

export async function run({ titleCard, durationMs }) {
  const frame = document.getElementById('display-frame');
  if (frame) frame.style.opacity = '0';
  setTimeout(() => titleCard.classList.add('in'), 200);
  titleCard.classList.remove('hidden');
  // durationMs comes from variants.js via composite ctx — keeps the
  // hold-time coupled to the slot the variant allocated. Fallback for
  // older callers / direct loads.
  await wait(Math.max(500, (durationMs || 6000) - TAIL_MS));
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
