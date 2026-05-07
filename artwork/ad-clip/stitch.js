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

const OUTPUT_DIR = path.resolve(__dirname, 'output');
const RAW_DIR = path.join(OUTPUT_DIR, 'raw');
const FRAME_EXT = 'jpg';
const MUSIC_PATH = path.resolve(__dirname, '..', '..', 'public', 'shared', 'music', 'lunar-joyride.mp3');

// Music level — drop to ~50% so the upbeat loop sits behind the visual.
// 0 disables audio entirely.
const MUSIC_VOLUME = parseFloat(process.env.AD_MUSIC_VOLUME);
const MUSIC_LEVEL = isNaN(MUSIC_VOLUME) ? 0.5 : MUSIC_VOLUME;
const MUSIC_OFFSET_SEC = parseFloat(process.env.AD_MUSIC_OFFSET_SEC) || 0;

const CLIP_ORDER = ['lobby-reveal', 'normal4p', 'pillow4p', 'neon4p', 'chaos8p', 'winner'];
const ASPECTS = ['16x9'];

// 400ms dissolve between every cut.
const XFADE_MS = 400;
const FPS = 60;
// Final-output upscale factor. Default 1 = ship the captured frames as-is
// (1080p). Set AD_OUT_SCALE=2 to lanczos-upscale to 4K for masters.
const OUT_SCALE = parseFloat(process.env.AD_OUT_SCALE) || 1;

function main() {
  if (!hasBin('ffmpeg')) {
    console.warn('ffmpeg not on PATH — skipping stitch.');
    process.exit(0);
  }
  if (!fs.existsSync(RAW_DIR)) {
    console.error(`Raw dir missing: ${RAW_DIR}. Run \`npm run ad:capture\` first.`);
    process.exit(1);
  }

  for (const aspect of ASPECTS) {
    stitchAspect(aspect);
  }
}

function stitchAspect(aspect) {
  const clipDirs = CLIP_ORDER.map((name) => path.join(RAW_DIR, `clip-${name}-${aspect}`));
  const missing = clipDirs.filter((d) => !fs.existsSync(path.join(d, 'meta.json')));
  if (missing.length > 0) {
    console.warn(`Skipping ${aspect} — missing inputs:\n  ${missing.join('\n  ')}`);
    return;
  }

  const metas = clipDirs.map((d) => JSON.parse(fs.readFileSync(path.join(d, 'meta.json'), 'utf-8')));
  const durations = metas.map((m) => m.frameCount / m.fps);

  const outPath = path.join(OUTPUT_DIR, `final-${aspect}.mp4`);
  console.log(`Stitching ${aspect} → ${path.relative(process.cwd(), outPath)} (xfade ${XFADE_MS}ms, ${FPS}fps)`);

  // Each clip is an image-sequence input. ffmpeg requires `-framerate` to
  // come BEFORE its `-i`, so we build the input args explicitly per clip.
  const inputArgs = [];
  for (const dir of clipDirs) {
    inputArgs.push('-framerate', String(FPS), '-i', path.join(dir, `frame-%04d.${FRAME_EXT}`));
  }

  // --- Filter graph: optional pre-processing per input, then xfade chain ---
  const xfadeSec = XFADE_MS / 1000;
  const preChain = [];
  if (OUT_SCALE !== 1) {
    const ref = metas[0];
    const targetW = Math.round(ref.captureWidth * OUT_SCALE);
    const targetH = Math.round(ref.captureHeight * OUT_SCALE);
    preChain.push(`scale=${targetW}:${targetH}:flags=lanczos`);
    console.log(`  upscale: ${ref.captureWidth}×${ref.captureHeight} → ${targetW}×${targetH}`);
  }

  const filterParts = [];
  for (let i = 0; i < clipDirs.length; i++) {
    if (preChain.length) {
      filterParts.push(`[${i}:v]${preChain.join(',')}[i${i}]`);
    }
  }
  const baseLabel = (i) => preChain.length ? `i${i}` : `${i}:v`;
  let runningOffset = durations[0] - xfadeSec;
  let lastLabel = baseLabel(0);
  for (let i = 1; i < clipDirs.length; i++) {
    const outLabel = i === clipDirs.length - 1 ? 'vout' : `v${i}`;
    filterParts.push(`[${lastLabel}][${baseLabel(i)}]xfade=transition=fade:duration=${xfadeSec}:offset=${runningOffset.toFixed(3)}[${outLabel}]`);
    runningOffset += durations[i] - xfadeSec;
    lastLabel = outLabel;
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
    '-crf', '18',
    '-r', String(FPS),
    '-profile:v', 'high', '-level', '5.1',
    '-movflags', '+faststart',
    outPath,
  );

  try {
    execFileSync('ffmpeg', args, { stdio: 'inherit' });
  } catch (err) {
    console.error(`ffmpeg failed for ${aspect}: ${err.message}`);
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
