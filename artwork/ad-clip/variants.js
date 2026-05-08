// Ad-clip variants — selected via AD_VARIANT env var. Each variant defines
// the sequence of clips that capture.js will record and stitch.js will
// concatenate. Clip definitions themselves (durations, AI pacing, prefill,
// per-player levels, etc.) live in the per-clip modules under
// public/artwork/ad-clip/clips/. Variants only choose which clips and in
// what order.
//
// Adding a new variant: pick a name, list the clips, plug into package.json
// (or invoke via `AD_VARIANT=<name> npm run ad`).

'use strict';

const VARIANTS = {
  full: {
    description: '30s trailer — lobby intro, four tier-showcase clips, QR card finale.',
    clips: [
      { name: 'lobby-reveal', durationMs: 3500 },
      { name: 'normal4p',     durationMs: 7000 },
      { name: 'pillow4p',     durationMs: 6000 },
      { name: 'neon4p',       durationMs: 5500 },
      { name: 'chaos8p',      durationMs: 7000 },
      { name: 'winner',       durationMs: 3000 },
    ],
  },

  clean: {
    description: '30s trailer — no lobby intro, four tier-showcase clips, plain-logo finale.',
    // 25.5s gameplay − 4 × 400ms xfades + 6.1s logo hold = ~30s.
    clips: [
      { name: 'normal4p', durationMs: 7000 },
      { name: 'pillow4p', durationMs: 6000 },
      { name: 'neon4p',   durationMs: 5500 },
      { name: 'chaos8p',  durationMs: 7000 },
      { name: 'logo',     durationMs: 6100 },
    ],
  },
};

function getVariant() {
  const name = process.env.AD_VARIANT || 'full';
  const variant = VARIANTS[name];
  if (!variant) {
    const known = Object.keys(VARIANTS).join(', ');
    throw new Error(`Unknown AD_VARIANT="${name}". Known: ${known}`);
  }
  return { ...variant, name };
}

module.exports = { VARIANTS, getVariant };
