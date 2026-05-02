// Ad-clip capture — Playwright records the composite page for each
// (clip, aspect) pair, producing webm files in artwork/ad-clip/output/raw/.
//
// Usage:
//   node artwork/ad-clip/capture.js
//   PORT=4100 node artwork/ad-clip/capture.js   # custom port
//
// Mirrors artwork/generate.js: spawns the dev server on PORT, drives
// Playwright off-screen, soft-fails if Playwright isn't installed.

'use strict';

const path = require('path');
const fs = require('fs');
const { spawn, execFileSync } = require('child_process');

const PORT = parseInt(process.env.PORT, 10) || 4100;
const BASE_URL = `http://localhost:${PORT}`;
const OUTPUT_RAW = path.resolve(__dirname, 'output', 'raw');

// Render scale — capture at deviceScaleFactor × CSS viewport so canvas/text
// stay sharp at higher output resolutions. SCALE=2 turns 1920×1080 layout
// into 3840×2160 frames (4K). Override with AD_SCALE=1 for fast iteration
// or AD_SCALE=3 for 5K masters.
const SCALE = parseFloat(process.env.AD_SCALE) || 2;

// Beat sequence: lobby reveal → escalating tier showcase (normal → pillow →
// neon) at 4p → 8-player chaos finale → winner CTA.
const CLIPS = [
  { name: 'lobby-reveal', durationMs: 2400 },
  { name: 'normal4p',     durationMs: 4500 },
  { name: 'pillow4p',     durationMs: 4000 },
  { name: 'neon4p',       durationMs: 3500 },
  { name: 'chaos8p',      durationMs: 5000 },
  { name: 'winner',       durationMs: 2400 },
];

// Aspects to capture. AD_ASPECT=16x9 (default) skips 9x16 portrait — set
// AD_ASPECT=both to render both, or AD_ASPECT=9x16 for portrait only.
const ASPECT_MODE = process.env.AD_ASPECT || '16x9';
const ALL_ASPECTS = [
  { name: '16x9', width: 1920, height: 1080 },
  { name: '9x16', width: 1080, height: 1920 },
];
const ASPECTS = ASPECT_MODE === 'both'
  ? ALL_ASPECTS
  : ALL_ASPECTS.filter((a) => a.name === ASPECT_MODE);

async function main() {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (err) {
    console.error('Playwright not installed. Run `npx playwright install chromium` first.');
    process.exit(1);
  }

  fs.mkdirSync(OUTPUT_RAW, { recursive: true });

  console.log(`Spawning server on port ${PORT}…`);
  const server = await spawnServer(PORT);

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--window-position=-2000,-2000'],
    });

    for (const aspect of ASPECTS) {
      for (const clip of CLIPS) {
        await captureOne(browser, aspect, clip);
      }
    }
  } finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
  }
  console.log('Capture complete →', OUTPUT_RAW);
}

// Capture one (clip, aspect) pair. Uses CDP startScreencast for exact-frame
// capture — recordVideo has timing/encoder quirks that produced static-looking
// outputs. Screencast frames land in tmpDir as PNGs, then ffmpeg assembles
// them into a fixed-fps webm timed precisely to the clip duration.
async function captureOne(browser, aspect, clip) {
  const url = `${BASE_URL}/artwork/ad-clip/index.html?clip=${encodeURIComponent(clip.name)}&aspect=${aspect.name}`;
  const targetPath = path.join(OUTPUT_RAW, `clip-${clip.name}-${aspect.name}.webm`);
  const tmpDir = path.join(OUTPUT_RAW, `_tmp-${clip.name}-${aspect.name}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const outW = Math.round(aspect.width * SCALE);
  const outH = Math.round(aspect.height * SCALE);
  console.log(`  capture ${clip.name} ${aspect.name} → ${outW}×${outH} (capture ${aspect.width}×${aspect.height}, scale ${SCALE}× via deviceScaleFactor + ffmpeg upscale)`);
  // Capture at native 1080p CSS viewport. CDP screencast outputs at the
  // viewport pixel size (~60 fps native), and deviceScaleFactor = SCALE
  // makes every canvas + text element render at SCALE× density inside that
  // 1080p frame — giving us crisp super-sampled anti-aliasing. The final
  // ffmpeg stitch lanczos-upscales the captured 1080p webms to outW×outH
  // so the user gets a SCALE× resolution file with content equivalent to
  // SCALE× supersampled 1080p. This trades "real" 4K detail for true
  // 60 fps motion smoothness, which a screencast at 4K can't deliver.
  const context = await browser.newContext({
    viewport: { width: aspect.width, height: aspect.height },
    deviceScaleFactor: SCALE,
  });
  const page = await context.newPage();
  page.on('pageerror', (err) => console.warn(`    [pageerror] ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.warn(`    [console.error] ${msg.text()}`);
  });

  const cdp = await context.newCDPSession(page);
  await cdp.send('Page.enable');

  const frames = [];
  let screencastActive = false;
  cdp.on('Page.screencastFrame', async (frame) => {
    if (screencastActive) {
      frames.push({ data: Buffer.from(frame.data, 'base64'), t: frame.metadata.timestamp });
    }
    try { await cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }); } catch (_) {}
  });

  let actualClipMs = clip.durationMs;
  let tStartReal = null;
  let tEndReal = null;
  try {
    await page.goto(url, { timeout: 10000 });
    await page.waitForFunction(() => window.__AD_CLIP_READY__ === true, null, { timeout: 15000 });
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 92,
      everyNthFrame: 1,
    });
    screencastActive = true;
    await page.waitForTimeout(80);
    await page.evaluate(() => { window.__AD_CLIP_GO__ = true; });
    await page.waitForFunction(() => window.__AD_CLIP_DONE__ === true, null, { timeout: clip.durationMs + 12000 });
    screencastActive = false;
    try { await cdp.send('Page.stopScreencast'); } catch (_) {}
    const result = await page.evaluate(() => ({
      err: window.__AD_CLIP_ERROR__ || null,
      tStart: window.__AD_CLIP_T_START__,
      tEnd: window.__AD_CLIP_T_END__,
    }));
    if (result.err) console.warn(`    clip reported error: ${result.err}`);
    tStartReal = result.tStart;
    tEndReal = result.tEnd;
    if (typeof tStartReal === 'number' && typeof tEndReal === 'number') {
      actualClipMs = Math.max(500, Math.round(tEndReal - tStartReal));
    }
  } finally {
    await context.close();
  }

  if (frames.length === 0) {
    console.warn(`    no frames captured`);
    return;
  }

  console.log(`    captured ${frames.length} frames @ ~${(frames.length / actualClipMs * 1000).toFixed(1)} fps native, target ${outW}×${outH}`);

  // Frames carry CDP wall-clock timestamps (seconds). Resample to a fixed
  // FPS by picking the closest frame for each output tick. Output covers
  // exactly clip.durationMs + tail.
  const FPS = 60;
  const TAIL_MS = 120;
  const totalOutMs = clip.durationMs + TAIL_MS;
  const totalOutFrames = Math.round((totalOutMs / 1000) * FPS);

  // Anchor t0 to the screencast frame nearest the clip's actual start
  // (we know clip start ≈ first usable frame because screencast was
  // armed BEFORE we dropped __AD_CLIP_GO__; first frame is the staged
  // scene at rest).
  const t0 = frames[0].t;
  const tEndSec = t0 + totalOutMs / 1000;

  let writeIdx = 0;
  for (let f = 0; f < totalOutFrames; f++) {
    const targetT = t0 + (f / FPS);
    if (targetT > tEndSec) break;
    let closest = frames[0];
    let bestDiff = Math.abs(closest.t - targetT);
    for (let i = 1; i < frames.length; i++) {
      const diff = Math.abs(frames[i].t - targetT);
      if (diff < bestDiff) { bestDiff = diff; closest = frames[i]; }
      if (frames[i].t - targetT > 0.1) break;
    }
    const outName = path.join(tmpDir, `frame-${String(writeIdx).padStart(4, '0')}.jpg`);
    fs.writeFileSync(outName, closest.data);
    writeIdx++;
  }

  if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
  // VP9 quality scales with resolution — slightly tighter CRF at 2x+ keeps
  // the per-pixel quality similar to the 1× baseline. -row-mt + -tile-columns
  // parallelise across cores so the 4K encode doesn't dominate runtime.
  const crf = SCALE >= 2 ? 28 : 30;
  try {
    execFileSync('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-framerate', String(FPS),
      '-i', path.join(tmpDir, 'frame-%04d.jpg'),
      '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', String(crf),
      '-pix_fmt', 'yuv420p',
      '-row-mt', '1', '-tile-columns', '4', '-threads', '8',
      '-an',
      targetPath,
    ], { stdio: 'inherit' });
  } catch (err) {
    console.warn(`    ffmpeg encode failed: ${err.message}`);
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  const sizeKB = (fs.statSync(targetPath).size / 1024).toFixed(0);
  console.log(`    → ${path.relative(process.cwd(), targetPath)} (${sizeKB}KB, clip ~${actualClipMs}ms, ${frames.length} frames captured)`);
}

function spawnServer(port) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [path.resolve(__dirname, '..', '..', 'server', 'index.js')], {
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        proc.kill();
        reject(new Error('Server did not start within 10s'));
      }
    }, 10000);
    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      if (!resolved && text.includes('running on')) {
        resolved = true;
        clearTimeout(timeout);
        resolve(proc);
      }
    });
    proc.stderr.on('data', (chunk) => process.stderr.write('[server] ' + chunk));
    proc.on('exit', (code) => {
      if (!resolved) {
        clearTimeout(timeout);
        reject(new Error(`Server exited early (code ${code})`));
      }
    });
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
