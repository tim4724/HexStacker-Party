// Stitch the per-clip JPEG frame sequences into the deliverables. Each clip
// dir was written by capture.js with frame-%04d.jpg + meta.json. We feed
// each as an ffmpeg image-sequence input, chain xfades between them, and
// encode one output per profile (see outputProfiles):
//
//   output/final-<variant>-16x9.mp4     master, native capture res
//   public/artwork/trailer.mp4          in-app welcome-screen trailer, 1080p
//   output/appstore-<variant>-16x9.mp4  App Store Connect preview, 1080p30
//
// Every profile is encoded straight from the frames in its own pass, so each
// costs exactly one generation of loss. Deriving the small outputs by
// re-encoding the master would be faster but stacks a second generation on
// top of the first — which is what made the old trailer look soft.

//
// Usage: node artwork/ad-clip/stitch.js
// Requires: ffmpeg + ffprobe on PATH. Soft-fails if ffmpeg is missing.

'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { describeVariants, getVariants } = require('./variants');

const OUTPUT_DIR = path.resolve(__dirname, 'output');
const RAW_DIR = path.join(OUTPUT_DIR, 'raw');
const FRAME_EXT = 'jpg';
const MUSIC_PATH = path.resolve(__dirname, '..', '..', 'public', 'shared', 'music', 'lunar-joyride.mp3');
// The `clean` variant is the published trailer (display/index.html plays it
// from /artwork/trailer.mp4). Publishing at the end of stitch keeps the
// output/ masters for side-by-side iteration and uploaders, while the
// public/ copy is re-encoded at PUBLISH_CRF delivery quality so clients
// don't download master-grade bytes.
const PUBLISH_VARIANT = 'clean';
const PUBLISH_ASPECT = '16x9';
const PUBLISH_PATH = path.resolve(__dirname, '..', '..', 'public', 'artwork', 'trailer.mp4');

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

// Final-output scale, relative to the captured frame size. Default 1 ships
// the master at whatever the capture produced — 3840×2160 under AD_PROD /
// AD_MAX, 1920×1080 otherwise. Output resolution is a capture-side decision
// (AD_SCALE); this knob only exists to rescale after the fact, e.g.
// AD_OUT_SCALE=0.5 to emit a 1080p master from 4K frames.
const OUT_SCALE_ENV = parseFloat(process.env.AD_OUT_SCALE);
const OUT_SCALE = Number.isFinite(OUT_SCALE_ENV) ? OUT_SCALE_ENV : 1;

// libx264 CRF — lower = higher quality + larger file. 18 is a sane default
// for social-platform delivery (which re-encodes anyway). 14 is a master.
// 6 (AD_MAX) is past "visually lossless" and close to the point of
// diminishing returns: the capture frames are JPEG q100 4:2:0, so below
// ~CRF 6 the encoder is mostly spending bits preserving JPEG's own
// artefacts rather than recovering detail.
// AD_CRF=0 enables true mathematically-lossless: also switches the encoder
// to yuv444p + high444 profile (libx264 rejects CRF 0 with the default
// yuv420p chroma subsampling). File is ~10× larger; rarely useful.
const CRF_ENV = parseInt(process.env.AD_CRF, 10);
const CRF = Number.isFinite(CRF_ENV) ? CRF_ENV : (MAX ? 6 : PROD ? 14 : 18);

// CRF for the in-app trailer served from public/artwork. Delivered at 1080p
// downscaled from the 4K capture, so it's a supersample rather than a native
// 1080p encode — edges and text survive the bitrate far better. Encoded from
// the source frames in its own pass (not re-encoded from the master), so it
// costs one generation of loss instead of two.
const PUBLISH_CRF_ENV = parseInt(process.env.AD_PUBLISH_CRF, 10);
const PUBLISH_CRF = Number.isFinite(PUBLISH_CRF_ENV) ? PUBLISH_CRF_ENV : 16;

// App Store Connect app-preview deliverable (output/appstore-<variant>-16x9.mp4),
// one per stitched variant. Every value here is pinned by Apple's spec, not
// by taste — see:
// https://developer.apple.com/help/app-store-connect/reference/app-preview-specifications/
//   - Apple TV previews are accepted at 1920×1080 ONLY. There is no 4K tier,
//     so the 4K capture's job here is to be a supersampled source.
//   - Max 30 fps (we capture 60, so this halves cleanly to 30).
//   - H.264 up to High Profile Level 4.0 — note the master ships Level 4.2,
//     which Apple would reject.
//   - Target bit rate 10-12 Mbps, hence VBR rather than the master's CRF.
//   - Audio must be stereo 256kbps AAC at 44.1 or 48 kHz.
//   - Length must be 15-30s inclusive. Both variants land at ~30.4s (each
//     clip carries capture.js's 120ms TAIL_MS past its declared duration),
//     so the deliverable is trimmed to APPSTORE_MAX_SEC with the music
//     fade-out retimed to match — a plain -t would cut the fade mid-way.
// ProRes 422 HQ is the other accepted codec and is nominally higher quality,
// but 1080p30 HQ runs ~176 Mbps → ~660MB for 30s, over Apple's 500MB cap.
const APPSTORE_WIDTH = 1920;
const APPSTORE_HEIGHT = 1080;
const APPSTORE_FPS = 30;
const APPSTORE_BITRATE = '11M';
const APPSTORE_MAXRATE = '12M';
const APPSTORE_BUFSIZE = '24M';
const APPSTORE_AUDIO_BITRATE = '256k';
const APPSTORE_AUDIO_RATE = 48000;
const APPSTORE_MAX_SEC = 29.9;
const APPSTORE_MAX_BYTES = 500 * 1024 * 1024;

function main() {
  const variants = getVariants();
  console.log(describeVariants(variants));

  if (!hasBin('ffmpeg')) {
    console.warn('ffmpeg not on PATH — skipping stitch.');
    process.exit(0);
  }
  if (!fs.existsSync(RAW_DIR)) {
    console.error(`Raw dir missing: ${RAW_DIR}. Run \`npm run ad:capture\` first.`);
    process.exit(1);
  }

  for (const variant of variants) {
    if (variants.length > 1) {
      console.log(`Variant: ${variant.name} — ${variant.description}`);
    }
    for (const aspect of ASPECTS) {
      stitchAspect(variant, aspect);
    }
  }

  if (!variants.some((v) => v.name === PUBLISH_VARIANT)) {
    console.log(`Note: variant "${PUBLISH_VARIANT}" not in this run — ${path.relative(process.cwd(), PUBLISH_PATH)} left untouched.`);
  }
}

// One entry per deliverable. Each is encoded in its own pass straight from
// the JPEG frames, so no output is a re-encode of another.
function outputProfiles(variant, aspect, ref) {
  const profiles = [{
    label: 'master',
    outPath: path.join(OUTPUT_DIR, `final-${variant.name}-${aspect}.mp4`),
    width: Math.round(ref.captureWidth * OUT_SCALE),
    height: Math.round(ref.captureHeight * OUT_SCALE),
    fps: FPS,
    crf: CRF,
    level: '4.2',
    audioBitrate: '192k',
  }];

  if (variant.name === PUBLISH_VARIANT && aspect === PUBLISH_ASPECT) {
    profiles.push({
      label: 'in-app trailer',
      outPath: PUBLISH_PATH,
      width: 1920,
      height: 1080,
      fps: FPS,
      crf: PUBLISH_CRF,
      level: '4.2',
      audioBitrate: '192k',
    });
  }

  profiles.push({
    label: 'App Store preview',
    outPath: path.join(OUTPUT_DIR, `appstore-${variant.name}-${aspect}.mp4`),
    width: APPSTORE_WIDTH,
    height: APPSTORE_HEIGHT,
    fps: APPSTORE_FPS,
    bitrate: APPSTORE_BITRATE,
    maxrate: APPSTORE_MAXRATE,
    bufsize: APPSTORE_BUFSIZE,
    level: '4.0',
    audioBitrate: APPSTORE_AUDIO_BITRATE,
    audioRate: APPSTORE_AUDIO_RATE,
    maxDurationSec: APPSTORE_MAX_SEC,
    maxBytes: APPSTORE_MAX_BYTES,
  });

  return profiles;
}

function stitchAspect(variant, aspect) {
  const clipNames = variant.clips.map((c) => c.name);
  const clipDirs = clipNames.map((name) => path.join(RAW_DIR, `clip-${name}-${aspect}`));
  const missing = clipDirs.filter((d) => !fs.existsSync(path.join(d, 'meta.json')));
  if (missing.length > 0) {
    console.warn(`Skipping ${aspect} — missing inputs:\n  ${missing.join('\n  ')}`);
    return;
  }

  const metas = clipDirs.map((d) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(d, 'meta.json'), 'utf-8'));
    } catch (err) {
      console.error(`Bad meta.json in ${d}: ${err.message}`);
      process.exit(1);
    }
  });
  const durations = metas.map((m) => m.frameCount / m.fps);

  const ref = metas[0];
  const totalSecFull = durations.reduce((a, b) => a + b, 0) - (clipDirs.length - 1) * (XFADE_MS / 1000);
  for (const profile of outputProfiles(variant, aspect, ref)) {
    encodeProfile(profile, { aspect, clipDirs, durations, ref, totalSecFull });
  }
}

function encodeProfile(profile, ctx) {
  const { aspect, clipDirs, durations, ref, totalSecFull } = ctx;
  const outPath = profile.outPath;
  const xfadeNote = clipDirs.length > 1 ? `xfade ${XFADE_MS}ms, ` : '';
  const rateNote = profile.crf != null ? `CRF ${profile.crf}` : `${profile.bitrate} VBR`;
  console.log(`Encoding ${profile.label} → ${path.relative(process.cwd(), outPath)} ` +
    `(${profile.width}×${profile.height}, ${xfadeNote}${profile.fps}fps, ${rateNote})`);

  // Each clip is an image-sequence input. ffmpeg requires `-framerate` to
  // come BEFORE its `-i`, so we build the input args explicitly per clip.
  const inputArgs = [];
  for (const dir of clipDirs) {
    inputArgs.push('-framerate', String(FPS), '-i', path.join(dir, `frame-%04d.${FRAME_EXT}`));
  }

  // --- Filter graph: optional uniform pre-scale, then xfade chain ---
  // Scaling happens per-input, BEFORE the xfade chain: for the 1080p
  // deliverables that means the blends run at 1080p instead of 4K, at no
  // quality cost (scale-then-blend and blend-then-scale are equivalent here).
  const xfadeSec = XFADE_MS / 1000;
  const targetW = profile.width;
  const targetH = profile.height;
  const needsScale = targetW !== ref.captureWidth || targetH !== ref.captureHeight;
  if (needsScale) {
    console.log(`  scale: ${ref.captureWidth}×${ref.captureHeight} → ${targetW}×${targetH} (lanczos)`);
  }

  const filterParts = [];
  for (let i = 0; i < clipDirs.length; i++) {
    if (needsScale) {
      filterParts.push(`[${i}:v]scale=${targetW}:${targetH}:flags=lanczos[i${i}]`);
    }
  }
  const baseLabel = (i) => needsScale ? `i${i}` : `${i}:v`;
  if (clipDirs.length === 1) {
    // Single-clip variant — no xfade chain to build. The `null` filter is a
    // pass-through that just relabels the stream so `-map [vraw]` works.
    filterParts.push(`[${baseLabel(0)}]null[vraw]`);
  } else {
    let runningOffset = durations[0] - xfadeSec;
    let lastLabel = baseLabel(0);
    for (let i = 1; i < clipDirs.length; i++) {
      const outLabel = i === clipDirs.length - 1 ? 'vraw' : `v${i}`;
      filterParts.push(`[${lastLabel}][${baseLabel(i)}]xfade=transition=fade:duration=${xfadeSec}:offset=${runningOffset.toFixed(3)}[${outLabel}]`);
      runningOffset += durations[i] - xfadeSec;
      lastLabel = outLabel;
    }
  }
  // Convert full-range JPEG input to TV-range yuv420p with bt709 tags. The
  // pixel data is actually remapped (scale=in_range=full:out_range=tv) —
  // not just relabeled — so colors render the same after players apply
  // TV-range expansion. Avoids the yuvj420p tag that some upload pipelines
  // reject (e.g. AirConsole's trailer uploader).
  filterParts.push('[vraw]scale=in_range=full:out_range=tv,format=yuv420p,setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709[vout]');

  // Duration the encode actually emits. Only the App Store profile caps it
  // (Apple's 30s ceiling); everything else runs the variant's full length.
  const totalSec = profile.maxDurationSec != null
    ? Math.min(totalSecFull, profile.maxDurationSec)
    : totalSecFull;
  if (totalSec < totalSecFull) {
    console.log(`  trim: ${totalSecFull.toFixed(2)}s → ${totalSec.toFixed(2)}s`);
  }

  // --- Audio: optional music bed mixed in the same pass ---
  const useMusic = MUSIC_LEVEL > 0 && fs.existsSync(MUSIC_PATH);
  const audioInputs = [];
  if (useMusic) {
    // -t caps music duration to the video length so a high MUSIC_OFFSET_SEC
    // near end-of-track can't make audio the shorter stream and let -shortest
    // truncate the video. The fade-out is timed off this profile's own
    // duration, so a trimmed output still ends on a complete fade.
    audioInputs.push('-ss', String(MUSIC_OFFSET_SEC), '-t', totalSec.toFixed(3), '-i', MUSIC_PATH);
    const fadeOutStart = Math.max(0, totalSec - 0.7);
    filterParts.push(
      `[${clipDirs.length}:a]volume=${MUSIC_LEVEL},` +
      `afade=t=in:st=0:d=0.5,afade=t=out:st=${fadeOutStart.toFixed(3)}:d=0.7[aout]`,
    );
  }

  const lossless = profile.crf === 0;
  const args = [
    '-y', '-loglevel', 'error', '-stats',
    ...inputArgs,
    ...audioInputs,
    '-filter_complex', filterParts.join(';'),
    '-map', '[vout]',
  ];
  if (useMusic) {
    args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', profile.audioBitrate, '-ac', '2');
    if (profile.audioRate) args.push('-ar', String(profile.audioRate));
    args.push('-shortest');
    console.log(`  music: ${path.basename(MUSIC_PATH)} @ ${MUSIC_LEVEL}× from ${MUSIC_OFFSET_SEC}s`);
  }
  args.push(
    '-c:v', 'libx264',
    '-pix_fmt', lossless ? 'yuv444p' : 'yuv420p',
    '-preset', 'slow',
  );
  if (profile.crf != null) {
    args.push('-crf', String(profile.crf));
  } else {
    args.push('-b:v', profile.bitrate, '-maxrate', profile.maxrate, '-bufsize', profile.bufsize);
  }
  args.push(
    '-r', String(profile.fps),
    '-t', totalSec.toFixed(3),
    '-profile:v', lossless ? 'high444' : 'high', '-level', profile.level,
    '-color_range', 'tv', '-colorspace', 'bt709',
    '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-movflags', '+faststart',
    outPath,
  );

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  try {
    execFileSync('ffmpeg', args, { stdio: 'inherit' });
  } catch (err) {
    console.error(`ffmpeg failed for ${profile.label} (${aspect}): ${err.message}`);
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
    if (profile.maxBytes != null) verifyAppStoreSpec(profile, outPath, actual);
  }
}

// Apple rejects an out-of-spec preview at upload, long after this script has
// exited, so the spec is asserted here rather than trusted. Checks what the
// encoder could plausibly get wrong; codec/profile/level are pinned above.
function verifyAppStoreSpec(profile, outPath, durationSec) {
  const probe = JSON.parse(execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate,profile,level',
    '-of', 'json', outPath,
  ], { encoding: 'utf-8' })).streams[0];

  const [num, den] = probe.r_frame_rate.split('/').map(Number);
  const fps = num / den;
  const bytes = fs.statSync(outPath).size;
  const problems = [];

  if (durationSec < 15 || durationSec > 30) problems.push(`duration ${durationSec.toFixed(2)}s outside Apple's 15-30s range`);
  if (probe.width !== APPSTORE_WIDTH || probe.height !== APPSTORE_HEIGHT) problems.push(`resolution ${probe.width}×${probe.height} — Apple TV previews must be ${APPSTORE_WIDTH}×${APPSTORE_HEIGHT}`);
  if (fps > 30.01) problems.push(`${fps.toFixed(2)}fps exceeds Apple's 30fps max`);
  // ffprobe reports level as an integer: 40 == Level 4.0.
  if (Number(probe.level) > 40) problems.push(`H.264 Level ${(Number(probe.level) / 10).toFixed(1)} exceeds Apple's High Profile Level 4.0`);
  if (bytes > profile.maxBytes) problems.push(`${(bytes / 1024 / 1024).toFixed(0)}MB exceeds Apple's 500MB max`);

  if (problems.length) {
    console.error(`App Store preview is out of spec:\n  - ${problems.join('\n  - ')}`);
    process.exit(1);
  }
  console.log(`  App Store spec OK: ${probe.width}×${probe.height}, ${fps.toFixed(0)}fps, ` +
    `${probe.profile} L${(Number(probe.level) / 10).toFixed(1)}, ${(bytes / 1024 / 1024).toFixed(1)}MB`);
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
