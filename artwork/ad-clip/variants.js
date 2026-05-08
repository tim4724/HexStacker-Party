// Ad-clip variants — selected via AD_VARIANT env var. Each variant defines
// the sequence of clips that capture.js will record and stitch.js will
// concatenate. By default, the pipeline processes every variant so a single
// `npm run ad` refreshes all deliverables while sharing common captures.
// Clip definitions themselves (durations, AI pacing, prefill, per-player
// levels, etc.) live in the per-clip modules under
// public/artwork/ad-clip/clips/. Variants only choose which clips and in
// what order.
//
// Adding a new variant: pick a name, list the clips. It will automatically
// be included in the default all-variant run. For targeted iteration, invoke
// with `AD_VARIANT=<name> npm run ad`.

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
  const name = process.env.AD_VARIANT || 'all';
  if (name === 'all') {
    throw new Error('AD_VARIANT="all" selects multiple variants. Use getVariants() instead.');
  }
  const variant = VARIANTS[name];
  if (!variant) {
    const known = Object.keys(VARIANTS).join(', ');
    throw new Error(`Unknown AD_VARIANT="${name}". Known: ${known}, all`);
  }
  return { ...variant, name };
}

function getVariants() {
  const selected = process.env.AD_VARIANT || 'all';
  const names = selected === 'all'
    ? Object.keys(VARIANTS)
    : selected.split(',').map((name) => name.trim()).filter(Boolean);

  const unknown = names.filter((name) => !VARIANTS[name]);
  if (unknown.length) {
    const known = Object.keys(VARIANTS).join(', ');
    throw new Error(`Unknown AD_VARIANT="${unknown.join(',')}". Known: ${known}, all`);
  }

  return names.map((name) => ({ ...VARIANTS[name], name }));
}

function describeVariants(variants) {
  if (variants.length === 1) {
    const variant = variants[0];
    return `Variant: ${variant.name} — ${variant.description}`;
  }
  return `Variants: ${variants.map((variant) => variant.name).join(', ')}`;
}

function getCaptureClips(variants) {
  const clipsByName = new Map();
  for (const variant of variants) {
    for (const clip of variant.clips) {
      const existing = clipsByName.get(clip.name);
      if (existing && existing.durationMs !== clip.durationMs) {
        throw new Error(
          `Clip "${clip.name}" has conflicting durations across selected variants ` +
          `(${existing.durationMs}ms vs ${clip.durationMs}ms). ` +
          'The raw output path is keyed by clip name, so this cannot be shared safely.',
        );
      }
      clipsByName.set(clip.name, clip);
    }
  }
  return Array.from(clipsByName.values());
}

module.exports = {
  VARIANTS,
  describeVariants,
  getCaptureClips,
  getVariant,
  getVariants,
};
