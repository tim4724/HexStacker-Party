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
const { getVariant } = require('./variants');

const PORT = parseInt(process.env.PORT, 10) || 4100;
const BASE_URL = `http://localhost:${PORT}`;
const OUTPUT_RAW = path.resolve(__dirname, 'output', 'raw');

// AD_PROD=1 — shorthand that bumps the per-knob defaults to "ship a master"
// settings. Each individual env var still wins if explicitly set, so e.g.
// AD_PROD=1 AD_JPEG_QUALITY=92 keeps the supersampling but compresses harder.
// Stitch reads the same flag for OUT_SCALE + CRF.
const PROD = process.env.AD_PROD === '1';

// Game-speed scale during recording. < 1 slows the in-page clock so each
// wall-clock second covers less game-time, giving the browser more time to
// paint per game-frame at the target 60fps output. Patches performance.now
// and Date.now in the composite + iframe contexts; canvas-based animations
// (the game's renderer) follow correctly. CSS animations and setTimeout
// keep wall-clock timing — fine for gameplay clips (no CSS-timed visuals)
// but would compress the lobby-reveal slot-pop-in and winner/logo fades.
// Capture wall-clock time becomes durationMs / TIME_SCALE per clip.
const TIME_SCALE = parseFloat(process.env.AD_TIME_SCALE) || (PROD ? 0.5 : 1);

// Render scale — Playwright deviceScaleFactor. SCALE=1 captures at native
// 1920×1080. SCALE=2 supersamples for crisper anti-aliasing on text/canvas
// at the cost of ~4× per-frame work. Pair with AD_OUT_SCALE=2 in stitch to
// actually deliver at 4K. The per-clip cap below is dropped when
// TIME_SCALE < 1 since the slowdown gives the browser extra budget to
// sustain the heavier load.
const SCALE = parseFloat(process.env.AD_SCALE) || (PROD ? 2 : 1);

// JPEG quality for screencast frames. 92 is the sweet spot at 1080p —
// visible artefacts only on smooth gradients, and the final H.264 encode
// dominates whatever quality we ship anyway. Bumped to 96 in prod.
const JPEG_QUALITY = parseInt(process.env.AD_JPEG_QUALITY, 10) || (PROD ? 96 : 92);

// Per-clip ceiling on the effective scale. chaos8p has 8 active board
// canvases; at SCALE=2 the browser falls below ~35fps native, which the
// resampler then pads with duplicates → visible judder in a 60fps output.
// The full-bleed display in chaos8p has no fine text to benefit from
// supersampling anyway, so capping at 1 is purely upside.
const SCALE_CAP_PER_CLIP = { chaos8p: 1 };

// Clips that DON'T get time-scaled. Their visuals depend on CSS animations
// (slot pop-in, fade-in transitions) which our perf.now patch can't reach,
// so applying the scale would compress those animations in playback. They
// also aren't compute-bound — there's no fps headroom problem to solve.
const NON_SCALABLE_CLIPS = new Set(['lobby-reveal', 'winner', 'logo']);

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

const ASPECTS = [
  { name: '16x9', width: 1920, height: 1080 },
];

async function main() {
  const variant = getVariant();
  console.log(`Variant: ${variant.name} — ${variant.description}`);
  if (PROD) console.log('AD_PROD=1: SCALE=2, JPEG=96, OUT_SCALE=2, CRF=14, TIME_SCALE=0.5');
  if (TIME_SCALE !== 1) console.log(`Time scale: ${TIME_SCALE}× (game runs at this speed during capture)`);

  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (err) {
    console.error('Playwright not installed. Run `npx playwright install chromium` first.');
    process.exit(1);
  }

  // Per-clip wipe (only the clips this variant captures), so variants can
  // coexist on disk — running `short` after `full` doesn't blow away the
  // gameplay clips, and stitch can re-render either variant without
  // re-capture as long as the configs haven't drifted.
  fs.mkdirSync(OUTPUT_RAW, { recursive: true });
  for (const aspect of ASPECTS) {
    for (const clip of variant.clips) {
      const dir = path.join(OUTPUT_RAW, `clip-${clip.name}-${aspect.name}`);
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log(`Spawning server on port ${PORT}…`);
  const server = await spawnServer(PORT);
  await waitForServer(PORT);

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    for (const aspect of ASPECTS) {
      for (const clip of variant.clips) {
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
  // `duration` is forwarded to clip modules via composite ctx so card-style
  // clips (logo, winner) can size their hold-time to the slot the variant
  // allocated. `timeScale` triggers in-page time patching so the game runs
  // slower than wall-clock for higher-quality recording (see TIME_SCALE).
  // Non-scalable clips (CSS-animated card/lobby) get scale=1 regardless.
  const clipTimeScale = NON_SCALABLE_CLIPS.has(clip.name) ? 1 : TIME_SCALE;
  const url = `${BASE_URL}/artwork/ad-clip/index.html?clip=${encodeURIComponent(clip.name)}&aspect=${aspect.name}&duration=${clip.durationMs}&timeScale=${clipTimeScale}`;
  const targetDir = path.join(OUTPUT_RAW, `clip-${clip.name}-${aspect.name}`);
  const stagingDir = path.join(targetDir, '_staging');
  fs.mkdirSync(stagingDir, { recursive: true });

  // The per-clip scale cap exists because heavy clips can't sustain 60fps
  // native at SCALE=2. With clipTimeScale < 1 the browser gets extra
  // wall-clock budget per game-second, so the cap stops applying.
  const rawCap = clipTimeScale < 1 ? null : SCALE_CAP_PER_CLIP[clip.name];
  const effectiveScale = rawCap != null ? Math.min(SCALE, rawCap) : SCALE;
  const cap = rawCap;
  const outW = Math.round(aspect.width * effectiveScale);
  const outH = Math.round(aspect.height * effectiveScale);
  const capNote = cap != null && SCALE > cap ? ` (capped from ${SCALE}×)` : '';
  console.log(`  capture ${clip.name} ${aspect.name} → ${aspect.width}×${aspect.height} @ ${effectiveScale}× DSF${capNote} (effective ${outW}×${outH})`);

  const context = await browser.newContext({
    viewport: { width: aspect.width, height: aspect.height },
    deviceScaleFactor: effectiveScale,
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
      // Wall-clock budget: clip's game-time slot stretched by
      // 1/clipTimeScale, plus the existing 12s safety margin for staging +
      // teardown.
      timeout: Math.round(clip.durationMs / clipTimeScale) + 12000,
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
  //
  // Output length follows actualClipMs (= run() return time, in game-time
  // since the page's perf.now is patched by TIME_SCALE) rather than the
  // configured durationMs. A clip that resolves early — gameplay-clip
  // detecting all-players-KO — produces a correspondingly shorter output
  // instead of being padded with frozen post-game frames. Capped at the
  // configured durationMs so a runaway clip still stops.
  //
  // Source frames carry wall-clock timestamps from CDP, so when
  // clipTimeScale < 1 they're spread across more wall-clock time than the
  // output covers. For each output frame f we want the source frame whose
  // game-time matches f/FPS — i.e. wall-clock f / (FPS × clipTimeScale)
  // past t0.
  const effectiveMs = Math.min(actualClipMs, clip.durationMs);
  const totalOutMs = effectiveMs + TAIL_MS;
  const totalOutFrames = Math.round((totalOutMs / 1000) * FPS);
  const t0 = frames[0].t;
  const tEndSec = t0 + (totalOutMs / 1000) / clipTimeScale;

  let cursor = 0;
  let writeIdx = 0;
  for (let f = 0; f < totalOutFrames; f++) {
    const targetT = t0 + f / (FPS * clipTimeScale);
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
    scale: effectiveScale,
  }, null, 2));

  fs.rmSync(stagingDir, { recursive: true, force: true });
  console.log(`    → ${path.relative(process.cwd(), targetDir)} (${writeIdx} frames, ~${actualClipMs}ms)`);
}

// Composition heartbeat — fires Page.captureScreenshot at COMPOSITION_HEARTBEAT_HZ
// purely for its documented side effect of forcing a Viz aggregation pass.
// The screenshot data is discarded.
//
// Implemented as a recursive setTimeout (NOT setInterval) so that only one
// captureScreenshot is in flight at a time. At SCALE=2 each call can take
// ~80-100ms; setInterval would queue up multiple calls behind the
// WebSocket-serialised CDP queue and starve the screencast itself. With
// chained setTimeout the heartbeat naturally throttles to whatever rate
// the browser can sustain.
//
// Errors during shutdown (page/context closing) are expected and
// suppressed. Other errors warn once so a real protocol problem is visible.
function startCompositionHeartbeat(cdp) {
  let stopped = false;
  let warned = false;
  let timer = null;
  const intervalMs = Math.round(1000 / COMPOSITION_HEARTBEAT_HZ);

  async function tick() {
    if (stopped) return;
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
    if (!stopped) timer = setTimeout(tick, intervalMs);
  }

  timer = setTimeout(tick, intervalMs);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
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
