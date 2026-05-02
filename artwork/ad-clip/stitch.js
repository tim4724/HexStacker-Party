// Stitch raw per-clip webm files into a final mp4 per aspect ratio.
//
// Usage: node artwork/ad-clip/stitch.js
// Requires: ffmpeg on PATH. Soft-fails if missing.

'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const OUTPUT_DIR = path.resolve(__dirname, 'output');
const RAW_DIR = path.join(OUTPUT_DIR, 'raw');

const CLIP_ORDER = ['lobby-reveal', 'normal4p', 'pillow4p', 'neon4p', 'chaos8p', 'winner'];
const ASPECT_MODE = process.env.AD_ASPECT || '16x9';
const ASPECTS = ASPECT_MODE === 'both'
  ? ['16x9', '9x16']
  : [ASPECT_MODE];

function main() {
  if (!hasFfmpeg()) {
    console.warn('ffmpeg not on PATH — skipping stitch. Install ffmpeg to produce final mp4s.');
    process.exit(0);
  }
  if (!fs.existsSync(RAW_DIR)) {
    console.error(`Raw clip dir missing: ${RAW_DIR}. Run \`npm run ad:capture\` first.`);
    process.exit(1);
  }

  for (const aspect of ASPECTS) {
    stitchAspect(aspect);
  }
}

// 400ms dissolve between every cut — long enough to read as an
// intentional transition (lobby → game, tier → tier, game → results)
// instead of a hard editorial cut.
const XFADE_MS = 400;
const FPS = 60;
// Motion interpolation off by default — capture now hits native ~60 fps
// at 1080p. Set AD_INTERPOLATE=1 to re-enable.
const INTERPOLATE = process.env.AD_INTERPOLATE === '1';
// Final-output upscale factor. Capture is at 1920×1080 (60 fps native);
// the stitch lanczos-upscales to SCALE× for the delivered file. Combined
// with deviceScaleFactor=SCALE during capture (which super-samples canvas
// + text), the output looks close to native 4K. AD_OUT_SCALE=1 to skip.
const OUT_SCALE = parseFloat(process.env.AD_OUT_SCALE) || parseFloat(process.env.AD_SCALE) || 2;

function stitchAspect(aspect) {
  const clipsForAspect = CLIP_ORDER.map((name) => path.join(RAW_DIR, `clip-${name}-${aspect}.webm`));
  const missing = clipsForAspect.filter((p) => !fs.existsSync(p));
  if (missing.length > 0) {
    console.warn(`Skipping ${aspect} — missing inputs:\n  ${missing.join('\n  ')}`);
    return;
  }

  const outPath = path.join(OUTPUT_DIR, `final-${aspect}.mp4`);
  console.log(`Stitching ${aspect} → ${path.relative(process.cwd(), outPath)} (xfade ${XFADE_MS}ms)`);

  // Build an ffmpeg filter graph that chains xfade across N inputs.
  // Each xfade overlap consumes XFADE_MS from the END of clip[i] and the
  // START of clip[i+1], so the running offset is sum(durations) - i*XFADE.
  const xfadeSec = XFADE_MS / 1000;

  const inputArgs = [];
  for (const p of clipsForAspect) {
    inputArgs.push('-i', p);
  }

  const durations = clipsForAspect.map((p) => probeDurationSec(p));

  // Filter complex: per-input pre-processing (minterpolate to FPS and/or
  // lanczos upscale), then chain xfades across all inputs.
  const filterParts = [];
  const preChain = [];
  if (INTERPOLATE) preChain.push(`minterpolate=fps=${FPS}:mi_mode=blend`);
  if (OUT_SCALE !== 1) {
    // Probe one webm to know its native size and compute the upscale target.
    const ref = ffprobeFirstStream(clipsForAspect[0]);
    const targetW = Math.round(ref.width * OUT_SCALE);
    const targetH = Math.round(ref.height * OUT_SCALE);
    preChain.push(`scale=${targetW}:${targetH}:flags=lanczos`);
    console.log(`  upscale: ${ref.width}×${ref.height} → ${targetW}×${targetH}`);
  }
  for (let i = 0; i < clipsForAspect.length; i++) {
    if (preChain.length) {
      filterParts.push(`[${i}:v]${preChain.join(',')}[i${i}]`);
    }
  }
  const baseLabel = (i) => preChain.length ? `i${i}` : `${i}:v`;
  let runningOffset = durations[0] - xfadeSec;
  let lastLabel = baseLabel(0);
  for (let i = 1; i < clipsForAspect.length; i++) {
    const outLabel = i === clipsForAspect.length - 1 ? 'vout' : `v${i}`;
    filterParts.push(`[${lastLabel}][${baseLabel(i)}]xfade=transition=fade:duration=${xfadeSec}:offset=${runningOffset.toFixed(3)}[${outLabel}]`);
    runningOffset += durations[i] - xfadeSec;
    lastLabel = outLabel;
  }

  try {
    execFileSync('ffmpeg', [
      '-y',
      ...inputArgs,
      '-filter_complex', filterParts.join(';'),
      '-map', '[vout]',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-preset', 'slow',
      // CRF 18 keeps per-pixel quality high at 4K without blowing up size
      // (still ~5–8 MB per 20-second clip). Bump to 16 if archiving as a
      // master, drop to 22 if you only need a preview.
      '-crf', '18',
      '-r', String(FPS),
      // High Profile + level 5.1 supports up to 4096×2160@30 H.264 — keeps
      // the file playable on hardware decoders / phones.
      '-profile:v', 'high', '-level', '5.1',
      '-movflags', '+faststart',
      outPath,
    ], { stdio: 'inherit' });
  } catch (err) {
    console.error(`ffmpeg failed for ${aspect}: ${err.message}`);
  }
}

function probeDurationSec(file) {
  const out = execFileSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    file,
  ]).toString().trim();
  return parseFloat(out);
}

function ffprobeFirstStream(file) {
  const out = execFileSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'stream=width,height',
    '-of', 'csv=p=0',
    file,
  ]).toString().trim();
  const [w, h] = out.split(',').map((n) => parseInt(n, 10));
  return { width: w, height: h };
}

function hasFfmpeg() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

main();
