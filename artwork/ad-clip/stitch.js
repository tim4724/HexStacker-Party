// Stitch the per-clip JPEG frame sequences into a single mp4. Each clip
// dir was written by capture.js with frame-%04d.jpg + meta.json. We feed
// each as an ffmpeg image-sequence input, chain xfades between them, and
// (optionally) lanczos-upscale the result for delivery.
//
// Single ffmpeg pass — no per-clip intermediate encode, so we save the
// VP9 round-trip the old pipeline did and avoid one generation of loss.
//
// Usage: node artwork/ad-clip/stitch.js
// Requires: ffmpeg + ffprobe on PATH. Soft-fails if ffmpeg is missing.

'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { getVariant } = require('./variants');

const OUTPUT_DIR = path.resolve(__dirname, 'output');
const RAW_DIR = path.join(OUTPUT_DIR, 'raw');
const FRAME_EXT = 'jpg';
const MUSIC_PATH = path.resolve(__dirname, '..', '..', 'public', 'shared', 'music', 'lunar-joyride.mp3');

// Music level — drop to ~50% so the upbeat loop sits behind the visual.
// 0 disables audio entirely.
const MUSIC_VOLUME = parseFloat(process.env.AD_MUSIC_VOLUME);
const MUSIC_LEVEL = isNaN(MUSIC_VOLUME) ? 0.5 : MUSIC_VOLUME;
const MUSIC_OFFSET_SEC = parseFloat(process.env.AD_MUSIC_OFFSET_SEC) || 0;

const ASPECTS = ['16x9'];

// 400ms dissolve between every cut.
const XFADE_MS = 400;
const FPS = 60;

// AD_PROD=1 — shorthand that flips defaults to "ship a master": 4K upscale
// + lower CRF for higher visual fidelity. Each individual env var overrides
// the prod default if explicitly set.
// AD_MAX=1 — superset of AD_PROD that drops CRF to 10 (visually lossless).
const MAX = process.env.AD_MAX === '1';
const PROD = process.env.AD_PROD === '1' || MAX;

// Final-output upscale factor. Default 1 = ship captured frames as-is
// (1080p). 2 lanczos-upscales to 4K. Pair with AD_SCALE=2 in capture so the
// upscale source is supersampled rather than just bilinearly enlarged.
// 8K (OUT_SCALE=4) is mostly cosmetic — the source detail caps at the
// supersampled-1080p ceiling regardless of upscale factor.
//
// In AD_MAX=1 mode the capture is already native 4K (3840×2160 viewport),
// so OUT_SCALE defaults to 1 — there's nothing to lanczos-upscale. PROD
// (without MAX) still defaults to 2 because that path captures at 1080p.
const OUT_SCALE = parseFloat(process.env.AD_OUT_SCALE) || (MAX ? 1 : PROD ? 2 : 1);

// libx264 CRF — lower = higher quality + larger file. 18 is a sane default
// for social-platform delivery (which re-encodes anyway). 14 is a master.
// 10 is "visually lossless" — gradient banding gone, fast-motion blur
// minimised, file ~3× larger. 23 is YouTube's recommended "default".
const CRF = parseInt(process.env.AD_CRF, 10) || (MAX ? 10 : PROD ? 14 : 18);

function main() {
  const variant = getVariant();
  console.log(`Variant: ${variant.name} — ${variant.description}`);

  if (!hasBin('ffmpeg')) {
    console.warn('ffmpeg not on PATH — skipping stitch.');
    process.exit(0);
  }
  if (!fs.existsSync(RAW_DIR)) {
    console.error(`Raw dir missing: ${RAW_DIR}. Run \`npm run ad:capture\` first.`);
    process.exit(1);
  }

  for (const aspect of ASPECTS) {
    stitchAspect(variant, aspect);
  }
}

function stitchAspect(variant, aspect) {
  const clipNames = variant.clips.map((c) => c.name);
  const clipDirs = clipNames.map((name) => path.join(RAW_DIR, `clip-${name}-${aspect}`));
  const missing = clipDirs.filter((d) => !fs.existsSync(path.join(d, 'meta.json')));
  if (missing.length > 0) {
    console.warn(`Skipping ${aspect} — missing inputs:\n  ${missing.join('\n  ')}`);
    return;
  }

  const metas = clipDirs.map((d) => JSON.parse(fs.readFileSync(path.join(d, 'meta.json'), 'utf-8')));
  const durations = metas.map((m) => m.frameCount / m.fps);

  const outPath = path.join(OUTPUT_DIR, `final-${variant.name}-${aspect}.mp4`);
  const xfadeNote = clipDirs.length > 1 ? `xfade ${XFADE_MS}ms, ` : '';
  console.log(`Stitching ${aspect} → ${path.relative(process.cwd(), outPath)} (${xfadeNote}${FPS}fps, CRF ${CRF})`);

  // Each clip is an image-sequence input. ffmpeg requires `-framerate` to
  // come BEFORE its `-i`, so we build the input args explicitly per clip.
  const inputArgs = [];
  for (const dir of clipDirs) {
    inputArgs.push('-framerate', String(FPS), '-i', path.join(dir, `frame-%04d.${FRAME_EXT}`));
  }

  // --- Filter graph: per-input pre-scale, then xfade chain ---
  // Target output size = largest input × OUT_SCALE. Inputs already at that
  // size pass through; smaller inputs (e.g. lobby in MAX mode falls back to
  // 1080p capture) lanczos-upscale to match. xfade requires uniform input
  // dimensions, so the scale step is mandatory once any source differs.
  const xfadeSec = XFADE_MS / 1000;
  const maxCapW = Math.max(...metas.map((m) => m.captureWidth));
  const maxCapH = Math.max(...metas.map((m) => m.captureHeight));
  const targetW = Math.round(maxCapW * OUT_SCALE);
  const targetH = Math.round(maxCapH * OUT_SCALE);

  const filterParts = [];
  let scaleNoteLogged = false;
  for (let i = 0; i < clipDirs.length; i++) {
    const m = metas[i];
    if (m.captureWidth !== targetW || m.captureHeight !== targetH) {
      filterParts.push(`[${i}:v]scale=${targetW}:${targetH}:flags=lanczos[i${i}]`);
      if (!scaleNoteLogged) {
        console.log(`  scale target: ${targetW}×${targetH}`);
        scaleNoteLogged = true;
      }
      console.log(`    ${path.basename(clipDirs[i])}: ${m.captureWidth}×${m.captureHeight} → ${targetW}×${targetH}`);
    } else {
      // Pass-through label so the xfade chain has a consistent name to
      // reference whether or not this input was scaled.
      filterParts.push(`[${i}:v]null[i${i}]`);
    }
  }
  const baseLabel = (i) => `i${i}`;
  if (clipDirs.length === 1) {
    // Single-clip variant — no xfade chain to build. The `null` filter is a
    // pass-through that just relabels the stream so `-map [vout]` works.
    filterParts.push(`[${baseLabel(0)}]null[vout]`);
  } else {
    let runningOffset = durations[0] - xfadeSec;
    let lastLabel = baseLabel(0);
    for (let i = 1; i < clipDirs.length; i++) {
      const outLabel = i === clipDirs.length - 1 ? 'vout' : `v${i}`;
      filterParts.push(`[${lastLabel}][${baseLabel(i)}]xfade=transition=fade:duration=${xfadeSec}:offset=${runningOffset.toFixed(3)}[${outLabel}]`);
      runningOffset += durations[i] - xfadeSec;
      lastLabel = outLabel;
    }
  }

  // --- Audio: optional music bed mixed in the same pass ---
  const totalSec = durations.reduce((a, b) => a + b, 0) - (clipDirs.length - 1) * xfadeSec;
  const useMusic = MUSIC_LEVEL > 0 && fs.existsSync(MUSIC_PATH);
  const audioInputs = [];
  if (useMusic) {
    audioInputs.push('-ss', String(MUSIC_OFFSET_SEC), '-i', MUSIC_PATH);
    const fadeOutStart = Math.max(0, totalSec - 0.7);
    filterParts.push(
      `[${clipDirs.length}:a]volume=${MUSIC_LEVEL},` +
      `afade=t=in:st=0:d=0.5,afade=t=out:st=${fadeOutStart.toFixed(3)}:d=0.7[aout]`,
    );
  }

  const args = [
    '-y', '-loglevel', 'error', '-stats',
    ...inputArgs,
    ...audioInputs,
    '-filter_complex', filterParts.join(';'),
    '-map', '[vout]',
  ];
  if (useMusic) {
    args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '192k', '-shortest');
    console.log(`  music: ${path.basename(MUSIC_PATH)} @ ${MUSIC_LEVEL}× from ${MUSIC_OFFSET_SEC}s`);
  }
  args.push(
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-preset', 'slow',
    '-crf', String(CRF),
    '-r', String(FPS),
    '-profile:v', 'high', '-level', '5.1',
    '-movflags', '+faststart',
    outPath,
  );

  try {
    execFileSync('ffmpeg', args, { stdio: 'inherit' });
  } catch (err) {
    console.error(`ffmpeg failed for ${variant.name}/${aspect}: ${err.message}`);
    console.error(`  command: ffmpeg ${args.map(quoteArg).join(' ')}`);
    process.exit(1);
  }

  // Sanity-check the encoded output: catches the silent failure mode where
  // ffmpeg returns 0 but produces a 0-frame or wrong-duration mp4 (e.g. a
  // bad filter graph that drops video but keeps audio).
  const expectedSec = totalSec;
  if (hasBin('ffprobe')) {
    const actual = parseFloat(execFileSync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1', outPath,
    ], { encoding: 'utf-8' }).trim());
    const drift = Math.abs(actual - expectedSec);
    if (!isFinite(actual) || drift > 0.5) {
      console.error(`encoded duration ${actual}s drifts ${drift.toFixed(2)}s from expected ${expectedSec.toFixed(2)}s`);
      process.exit(1);
    }
    console.log(`  verified: ${actual.toFixed(2)}s (expected ${expectedSec.toFixed(2)}s)`);
  }
}

function quoteArg(a) {
  return /[\s'"\\]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a;
}

function hasBin(name) {
  try {
    execFileSync(name, ['-version'], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

main();
