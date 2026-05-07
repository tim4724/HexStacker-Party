// Ad-clip capture — Playwright drives the composite page for each clip,
// CDP screencast streams JPEG frames to disk at the browser's native paint
// rate (~95 fps), and the frames are resampled to a fixed FPS for the stitch
// step.
//
// Why screencast (not Page.captureScreenshot per frame): screencast is the
// purpose-built API for streaming captures and runs at the browser's natural
// paint rate without round-tripping every frame through the WebSocket. A
// per-frame captureScreenshot loop tops out at ~30 fps on this hardware
// because each call serialises a full JPEG over CDP.
//
// Why the composition-forcing heartbeat: in Chromium's new headless mode
// (132+) the parent page's framebuffer holds a SurfaceLayer reference to
// the iframe's last submitted compositor frame. Aggregation only re-runs
// when the parent receives a BeginFrame. With low-input clips, neither the
// iframe submits new frames frequently enough nor does the parent get
// driven hard enough — and the screencast re-emits the cached aggregated
// frame. We saw this concretely: low-input clips produced only 2-122
// unique frames out of 427.
//
// Per Chromium's headless lead (Eric Seckler) on chromium-discuss,
// Page.captureScreenshot is the documented trigger to force a full Viz
// aggregation + draw. HeadlessExperimental.beginFrame is the semantically-
// correct API but requires Target.createTarget({enableBeginFrameControl:
// true}) at target creation (not a launch flag) plus --deterministic-mode,
// and is known-broken on macOS — not viable here.
//
// So: a low-rate heartbeat fires Page.captureScreenshot purely for its
// side effect of forcing aggregation. The screenshot is captured against
// a 1×1 clip at quality=1 so the JPEG encode cost is negligible; we
// discard the result. This is the canonical workaround, not a kludge.
//
// Usage:
//   node artwork/ad-clip/capture.js
//   PORT=4100 AD_SCALE=1 node artwork/ad-clip/capture.js   # fast iteration
//
// Output: output/raw/clip-<name>-16x9/frame-%04d.jpg + meta.json per clip.

'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.PORT, 10) || 4100;
const BASE_URL = `http://localhost:${PORT}`;
const OUTPUT_RAW = path.resolve(__dirname, 'output', 'raw');

// Render scale — Playwright deviceScaleFactor. SCALE=1 captures at native
// 1920×1080. SCALE=2 supersamples for crisper anti-aliasing on text/canvas
// at the cost of ~4× per-frame work; only useful if you also stitch at
// AD_OUT_SCALE=2 (i.e. deliver a 4K master).
const SCALE = parseFloat(process.env.AD_SCALE) || 1;

// JPEG quality for screencast frames. 92 is the sweet spot at 1080p —
// visible artefacts only on smooth gradients, and the final H.264 encode
// dominates whatever quality we ship anyway.
const JPEG_QUALITY = parseInt(process.env.AD_JPEG_QUALITY, 10) || 92;

// Output frame rate. Native screencast emits at ~95 fps at 1080p, so 60 fps
// output gets near-1:1 nearest-neighbour copies (rare duplicates).
const FPS = 60;
// Tail buffer captured past the clip's `durationMs` so the closing animation
// frame lands fully inside the captured timeline. Mirrors the trailing
// wait(120) at the end of composite.js's run().
const TAIL_MS = 120;

// Composition-forcing heartbeat rate. 30 Hz is the empirically-determined
// floor on this hardware — at 15 Hz we observed intermittent staleness on
// pillow4p (1 in 3 runs). 30 Hz held 100% across repeated runs. The
// 1×1-clip optimization recommended in chromium-discuss did NOT work here
// (it skipped the full-viewport aggregation we depend on), so each tick
// is a full-page captureScreenshot at quality=1.
const COMPOSITION_HEARTBEAT_HZ = 30;

const CLIPS = [
  { name: 'lobby-reveal', durationMs: 3500 },
  { name: 'normal4p',     durationMs: 7000 },
  { name: 'pillow4p',     durationMs: 6000 },
  { name: 'neon4p',       durationMs: 5500 },
  { name: 'chaos8p',      durationMs: 7000 },
  { name: 'winner',       durationMs: 3000 },
];

const ASPECTS = [
  { name: '16x9', width: 1920, height: 1080 },
];

async function main() {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (err) {
    console.error('Playwright not installed. Run `npx playwright install chromium` first.');
    process.exit(1);
  }

  // Single wipe at start — kills orphans from earlier pipeline revisions
  // (renamed clip dirs, legacy intermediates) without per-clip cleanup that
  // only knows current names.
  if (fs.existsSync(OUTPUT_RAW)) fs.rmSync(OUTPUT_RAW, { recursive: true, force: true });
  fs.mkdirSync(OUTPUT_RAW, { recursive: true });

  console.log(`Spawning server on port ${PORT}…`);
  const server = await spawnServer(PORT);
  await waitForServer(PORT);

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
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

async function captureOne(browser, aspect, clip) {
  const url = `${BASE_URL}/artwork/ad-clip/index.html?clip=${encodeURIComponent(clip.name)}&aspect=${aspect.name}`;
  const targetDir = path.join(OUTPUT_RAW, `clip-${clip.name}-${aspect.name}`);
  const stagingDir = path.join(targetDir, '_staging');
  fs.mkdirSync(stagingDir, { recursive: true });

  const outW = Math.round(aspect.width * SCALE);
  const outH = Math.round(aspect.height * SCALE);
  console.log(`  capture ${clip.name} ${aspect.name} → ${aspect.width}×${aspect.height} @ ${SCALE}× DSF (effective ${outW}×${outH})`);

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

  // Frames stream straight to disk (bounded memory regardless of clip
  // length), tagged with their CDP wall-clock timestamp for the resampler.
  const frames = [];
  let screencastActive = false;
  let firstFrameResolve = null;
  const firstFramePromise = new Promise((r) => { firstFrameResolve = r; });
  let ackErrorWarned = false;

  cdp.on('Page.screencastFrame', async (frame) => {
    if (screencastActive) {
      const seq = frames.length;
      const stagingPath = path.join(stagingDir, `f${String(seq).padStart(6, '0')}.jpg`);
      fs.writeFileSync(stagingPath, Buffer.from(frame.data, 'base64'));
      frames.push({ t: frame.metadata.timestamp, path: stagingPath });
      if (firstFrameResolve) { firstFrameResolve(); firstFrameResolve = null; }
    }
    // Ack failures are expected during teardown (page closing races with
    // pending frames). Warn once so a real ack failure mid-clip is visible.
    try {
      await cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId });
    } catch (err) {
      if (!ackErrorWarned) {
        console.warn(`    [screencast ack] ${err.message} — further occurrences suppressed`);
        ackErrorWarned = true;
      }
    }
  });

  let actualClipMs = clip.durationMs;
  let clipError = null;
  let stopHeartbeat = null;

  try {
    await page.goto(url, { timeout: 10000 });
    await page.waitForFunction(() => window.__AD_CLIP_READY__ === true, null, { timeout: 15000 });

    // Set the gate BEFORE the screencast start so we never drop a frame
    // that arrives in the resolve-microtask of cdp.send.
    screencastActive = true;
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: JPEG_QUALITY,
      everyNthFrame: 1,
    });

    // Wait for the first frame to confirm the recorder is live before
    // releasing the clip — animation will then begin inside the captured
    // timeline rather than racing the screencast.
    await Promise.race([
      firstFramePromise,
      new Promise((_, rej) => setTimeout(() => rej(new Error('no screencast frame within 2s')), 2000)),
    ]);

    stopHeartbeat = startCompositionHeartbeat(cdp);
    await page.evaluate(() => { window.__AD_CLIP_GO__ = true; });
    await page.waitForFunction(() => window.__AD_CLIP_DONE__ === true, null, {
      timeout: clip.durationMs + 12000,
    });

    screencastActive = false;
    await cdp.send('Page.stopScreencast');

    const result = await page.evaluate(() => ({
      err: window.__AD_CLIP_ERROR__ || null,
      tStart: window.__AD_CLIP_T_START__,
      tEnd: window.__AD_CLIP_T_END__,
    }));
    clipError = result.err;
    if (typeof result.tStart === 'number' && typeof result.tEnd === 'number') {
      actualClipMs = Math.round(result.tEnd - result.tStart);
    }
  } finally {
    if (stopHeartbeat) stopHeartbeat();
    await context.close();
  }

  if (clipError) {
    fs.rmSync(targetDir, { recursive: true, force: true });
    throw new Error(`clip "${clip.name}" reported error: ${clipError}`);
  }
  if (frames.length === 0) {
    fs.rmSync(targetDir, { recursive: true, force: true });
    throw new Error(`clip "${clip.name}" produced no frames`);
  }

  console.log(`    captured ${frames.length} frames @ ~${(frames.length / actualClipMs * 1000).toFixed(1)} fps native`);

  // Resample staging frames → fixed-FPS sequence in targetDir. Both inputs
  // and output ticks are sorted by time, so a moving cursor finds nearest-
  // neighbour for every output tick in O(N).
  const totalOutMs = clip.durationMs + TAIL_MS;
  const totalOutFrames = Math.round((totalOutMs / 1000) * FPS);
  const t0 = frames[0].t;
  const tEndSec = t0 + totalOutMs / 1000;

  let cursor = 0;
  let writeIdx = 0;
  for (let f = 0; f < totalOutFrames; f++) {
    const targetT = t0 + f / FPS;
    if (targetT > tEndSec) break;
    while (cursor + 1 < frames.length &&
           Math.abs(frames[cursor + 1].t - targetT) <= Math.abs(frames[cursor].t - targetT)) {
      cursor++;
    }
    const dst = path.join(targetDir, `frame-${String(writeIdx).padStart(4, '0')}.jpg`);
    fs.copyFileSync(frames[cursor].path, dst);
    writeIdx++;
  }

  fs.writeFileSync(path.join(targetDir, 'meta.json'), JSON.stringify({
    frameCount: writeIdx,
    fps: FPS,
    durationMs: clip.durationMs,
    actualClipMs,
    captureWidth: aspect.width,
    captureHeight: aspect.height,
    scale: SCALE,
  }, null, 2));

  fs.rmSync(stagingDir, { recursive: true, force: true });
  console.log(`    → ${path.relative(process.cwd(), targetDir)} (${writeIdx} frames, ~${actualClipMs}ms)`);
}

// Composition heartbeat — fires Page.captureScreenshot at COMPOSITION_HEARTBEAT_HZ
// purely for its documented side effect of forcing a Viz aggregation pass.
// The 1×1 clip + quality=1 reduces the JPEG encode to a few bytes; the
// screenshot data is discarded.
//
// Errors during shutdown (page/context closing) are expected and
// suppressed. Other errors warn once so a real protocol problem is visible.
function startCompositionHeartbeat(cdp) {
  let warned = false;
  const intervalMs = Math.round(1000 / COMPOSITION_HEARTBEAT_HZ);
  const timer = setInterval(async () => {
    try {
      await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 1 });
    } catch (err) {
      const msg = err && err.message || '';
      if (msg.includes('closed') || msg.includes('detached')) return;
      if (!warned) {
        console.warn(`    [composition heartbeat] ${msg} — further occurrences suppressed`);
        warned = true;
      }
    }
  }, intervalMs);
  return () => clearInterval(timer);
}

function spawnServer(port) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [path.resolve(__dirname, '..', '..', 'server', 'index.js')], {
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stderr.on('data', (chunk) => process.stderr.write('[server] ' + chunk));
    // waitForServer() polls /health for actual readiness — much sturdier
    // than parsing stdout for a magic "running on" string.
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code !== 0 && code !== null) reject(new Error(`Server exited early (code ${code})`));
    });
    resolve(proc);
  });
}

async function waitForServer(port, timeoutMs = 10000) {
  const url = `http://localhost:${port}/health`;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Server did not respond at ${url} within ${timeoutMs}ms`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
