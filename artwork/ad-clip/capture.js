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
const crypto = require('crypto');
const { spawn } = require('child_process');
const { getVariant } = require('./variants');

const PORT = parseInt(process.env.PORT, 10) || 4100;
const BASE_URL = `http://localhost:${PORT}`;
const OUTPUT_RAW = path.resolve(__dirname, 'output', 'raw');

// AD_PROD=1 — shorthand that bumps the per-knob defaults to "ship a master"
// settings. Each individual env var still wins if explicitly set, so e.g.
// AD_PROD=1 AD_JPEG_QUALITY=92 keeps the supersampling but compresses harder.
// Stitch reads the same flag for OUT_SCALE + CRF.
//
// AD_MAX=1 — superset of AD_PROD: native 4K capture (viewport 3840×2160 +
// DSF=1, no lanczos upscale at stitch), JPEG=100, CRF=10, TIME_SCALE=0.25.
// Every output pixel is rendered natively at 4K — no supersampled-then-
// downsampled-then-upscaled trick. composite.css uses a `--s` variable that
// doubles every fixed-px dimension when body.true-4k is set; the display
// iframe inherits the bigger CSS viewport and renders its canvas natively
// at 4K too. Trades ~2× capture wall-time (TIME_SCALE 0.5 → 0.25) for the
// real-4K rasterisation.
const MAX = process.env.AD_MAX === '1';
const PROD = process.env.AD_PROD === '1' || MAX;
// True-4K capture: only enabled in MAX mode for now.
const TRUE_4K = MAX;

// Game-speed scale during recording. < 1 slows the in-page clock so each
// wall-clock second covers less game-time, giving the browser more time to
// paint per game-frame at the target 60fps output. Patches performance.now
// and Date.now in the composite + iframe contexts; canvas-based animations
// (the game's renderer) follow correctly. CSS animations and setTimeout
// keep wall-clock timing — fine for gameplay clips (no CSS-timed visuals)
// but would compress the lobby-reveal slot-pop-in and winner/logo fades.
// Capture wall-clock time becomes durationMs / TIME_SCALE per clip.
const TIME_SCALE = parseFloat(process.env.AD_TIME_SCALE) || (MAX ? 0.25 : PROD ? 0.5 : 1);

// Render scale — Playwright deviceScaleFactor. SCALE=1 captures at native
// 1920×1080. SCALE=2 supersamples for crisper anti-aliasing on text/canvas
// at the cost of ~4× per-frame work. Pair with AD_OUT_SCALE=2 in stitch to
// actually deliver at 4K. The per-clip cap below is dropped when
// TIME_SCALE < 1 since the slowdown gives the browser extra budget to
// sustain the heavier load.
//
// In TRUE_4K mode the supersampling trick is dropped — we capture at a
// 3840×2160 CSS viewport with DSF=1, so the screencast already emits 4K
// frames natively. SCALE then defaults to 1 (no extra DSF supersampling
// on top of the 4K viewport — it would require 8K internal raster, which
// the browser can't sustain on chaos8p).
const SCALE = parseFloat(process.env.AD_SCALE) || (TRUE_4K ? 1 : PROD ? 2 : 1);

// JPEG quality for screencast frames. 92 is the sweet spot at 1080p —
// visible artefacts only on smooth gradients, and the final H.264 encode
// dominates whatever quality we ship anyway. Bumped to 96 in prod, 100
// (effectively lossless) in max.
const JPEG_QUALITY = parseInt(process.env.AD_JPEG_QUALITY, 10) || (MAX ? 100 : PROD ? 96 : 92);

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

// Clips that opt OUT of the TRUE_4K native-viewport path even when AD_MAX=1.
// Reason: paint cost at 3840×2160 viewport for heavy DOM (gradient title,
// animated player cards, welcomeBg canvas, backdrop-filter) couldn't
// sustain 60fps native — observed ~18-34fps. They get the PROD path
// instead: viewport 1920×1080 + DSF=2 supersample + lanczos upscale at
// stitch. Lanczos quality is invisible here (large gradients + headline
// text, no fine canvas detail), and we get a clean 60fps capture.
const FORCE_PROD_PATH_CLIPS = new Set(['lobby-reveal']);

// Per-clip threshold (ms) for the post-capture freeze sniff. If we observe
// a longer run of byte-identical source frames than this, the iframe's
// compositor cache likely went stale during capture and we retry. Static
// card clips have multi-second static content by design — Infinity skips
// the sniff for them.
const FREEZE_THRESHOLD_MS = {
  'lobby-reveal': 1500,
  normal4p: 1000,
  pillow4p: 1000,
  neon4p:   1000,
  chaos8p:  1000,
  winner: Infinity,
  logo:   Infinity,
};
const MAX_CAPTURE_ATTEMPTS = 3;

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

// Base CSS dimensions of the composite stage. TRUE_4K doubles the actual
// capture viewport (composite.css scales fixed-px values via the `--s` var)
// but the BASE values stay the same so meta.json + stitch arithmetic keep
// thinking in base coordinates. The doubled viewport is captured at
// captureWidth/Height (which IS 3840×2160 in true-4k mode) by way of
// VIEWPORT_MUL below.
const ASPECTS = [
  { name: '16x9', width: 1920, height: 1080 },
];

// Viewport multiplier — only != 1 in TRUE_4K mode. Multiplies CSS-viewport
// (and therefore the screencast frame size) without touching DSF, so the
// browser actually rasterises at 4K instead of supersampling 1080.
const VIEWPORT_MUL = TRUE_4K ? 2 : 1;

async function main() {
  const variant = getVariant();
  console.log(`Variant: ${variant.name} — ${variant.description}`);
  if (MAX) console.log('AD_MAX=1: VIEWPORT=3840×2160 (true 4K), DSF=1, JPEG=100, OUT_SCALE=1, CRF=10, TIME_SCALE=0.25');
  else if (PROD) console.log('AD_PROD=1: SCALE=2, JPEG=96, OUT_SCALE=2, CRF=14, TIME_SCALE=0.5');
  if (TIME_SCALE !== 1) console.log(`Time scale: ${TIME_SCALE}× (game runs at this speed during capture)`);

  let chromium;
  try {
    // @playwright/test is what's in devDependencies; it re-exports the same
    // `chromium` namespace as the `playwright` core package, so requiring it
    // directly avoids relying on the implicit transitive dep on `playwright`.
    ({ chromium } = require('@playwright/test'));
  } catch (err) {
    console.error('Playwright not installed. Run `npx playwright install chromium` first.');
    process.exit(1);
  }

  // Per-clip wipe (only the clips this variant captures), so variants can
  // coexist on disk — running `clean` after `full` keeps the shared
  // gameplay clips intact, and stitch can re-render either variant without
  // re-capture as long as the configs haven't drifted.
  fs.mkdirSync(OUTPUT_RAW, { recursive: true });
  for (const aspect of ASPECTS) {
    for (const clip of variant.clips) {
      const dir = path.join(OUTPUT_RAW, `clip-${clip.name}-${aspect.name}`);
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // Server + browser both live in the try so a `waitForServer` timeout
  // (or any spawn/launch error) still tears down the spawned process —
  // otherwise an orphaned node would hold the port and break the next run.
  let server = null;
  let browser = null;
  try {
    console.log(`Spawning server on port ${PORT}…`);
    server = spawnServer(PORT);
    await waitForServer(PORT, server);
    browser = await chromium.launch({ headless: true });
    for (const aspect of ASPECTS) {
      for (const clip of variant.clips) {
        await captureWithRetry(browser, aspect, clip);
      }
    }
  } finally {
    if (browser) await browser.close();
    if (server) server.kill('SIGTERM');
  }
  console.log('Capture complete →', OUTPUT_RAW);
}

async function captureOne(browser, aspect, clip, opts) {
  const skipFreezeCheck = !!(opts && opts.skipFreezeCheck);
  // `duration` is forwarded to clip modules via composite ctx so card-style
  // clips (logo, winner) can size their hold-time to the slot the variant
  // allocated. `timeScale` triggers in-page time patching so the game runs
  // slower than wall-clock for higher-quality recording (see TIME_SCALE).
  // Non-scalable clips (CSS-animated card/lobby) get scale=1 regardless.
  const clipTimeScale = NON_SCALABLE_CLIPS.has(clip.name) ? 1 : TIME_SCALE;
  // Per-clip override: lobby (and similar heavy-DOM clips) can't sustain
  // 60fps when rasterising at 3840×2160 native, so they fall back to the
  // PROD path (1920×1080 viewport + DSF=2 supersample) even when AD_MAX=1
  // is set. Stitch picks up the smaller capture dims from meta.json and
  // lanczos-upscales just these clips to match the 4K xfade target.
  const useTrue4kForClip = TRUE_4K && !FORCE_PROD_PATH_CLIPS.has(clip.name);
  const true4kParam = useTrue4kForClip ? '&true4k=1' : '';
  const url = `${BASE_URL}/artwork/ad-clip/index.html?clip=${encodeURIComponent(clip.name)}&aspect=${aspect.name}&duration=${clip.durationMs}&timeScale=${clipTimeScale}${true4kParam}`;
  const targetDir = path.join(OUTPUT_RAW, `clip-${clip.name}-${aspect.name}`);
  const stagingDir = path.join(targetDir, '_staging');
  fs.mkdirSync(stagingDir, { recursive: true });

  // The per-clip scale cap exists because heavy clips can't sustain 60fps
  // native at SCALE=2. With clipTimeScale < 1 the browser gets extra
  // wall-clock budget per game-second, so the cap stops applying.
  const rawCap = clipTimeScale < 1 ? null : SCALE_CAP_PER_CLIP[clip.name];
  // PROD-path fallback uses DSF=2 (the original supersampling trick); native
  // 4K path uses DSF=1 (no supersample on top of the bigger viewport).
  const baseScale = useTrue4kForClip ? SCALE : (TRUE_4K ? 2 : SCALE);
  const effectiveScale = rawCap != null ? Math.min(baseScale, rawCap) : baseScale;
  // Capture viewport: TRUE_4K-eligible clips get the full 4K rasterisation
  // surface; PROD-path clips stay at base 1920×1080 with DSF supersampling.
  const viewportMul = useTrue4kForClip ? VIEWPORT_MUL : 1;
  const viewportW = aspect.width * viewportMul;
  const viewportH = aspect.height * viewportMul;
  const outW = Math.round(viewportW * effectiveScale);
  const outH = Math.round(viewportH * effectiveScale);
  const capNote = rawCap != null && baseScale > rawCap ? ` (capped from ${baseScale}×)` : '';
  const pathNote = TRUE_4K && !useTrue4kForClip ? ' [PROD path]' : '';
  console.log(`  capture ${clip.name} ${aspect.name} → ${viewportW}×${viewportH} @ ${effectiveScale}× DSF${capNote}${pathNote} (effective ${outW}×${outH})`);

  const context = await browser.newContext({
    viewport: { width: viewportW, height: viewportH },
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

  // Freeze sniff — scan source frames for the longest run of byte-identical
  // images. If it exceeds this clip's threshold, the iframe layer almost
  // certainly went stale mid-capture (the compositor-cache bug we work
  // around with the heartbeat). Caller retries on the same browser.
  // skipFreezeCheck=true is used by the last-resort retry path in
  // captureWithRetry so that we always commit frames to disk after the
  // attempt budget is exhausted (otherwise stitch would fail with no
  // input dir for this clip).
  const maxFreezeMs = detectMaxFreezeMs(frames);
  const threshold = FREEZE_THRESHOLD_MS[clip.name] != null ? FREEZE_THRESHOLD_MS[clip.name] : 1000;
  if (!skipFreezeCheck && maxFreezeMs > threshold) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
    return { freezeDetected: true, maxFreezeMs, threshold };
  }

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
    // captureWidth/Height = actual screencast frame dimensions in pixels
    // (== viewport CSS size, since DSF doesn't enlarge the screencast frame).
    // stitch reads these to compute its lanczos target, so they must reflect
    // what's actually on disk — 3840×2160 in TRUE_4K mode, 1920×1080 otherwise.
    captureWidth: viewportW,
    captureHeight: viewportH,
    scale: effectiveScale,
  }, null, 2));

  fs.rmSync(stagingDir, { recursive: true, force: true });
  console.log(`    → ${path.relative(process.cwd(), targetDir)} (${writeIdx} frames, ~${actualClipMs}ms, max freeze ${maxFreezeMs.toFixed(0)}ms)`);
  return { freezeDetected: false, maxFreezeMs };
}

// Wrap captureOne with retry-on-freeze. Up to MAX_CAPTURE_ATTEMPTS
// freeze-checked attempts; each is a fresh browser context, so transient
// compositor-cache issues from one run don't carry over. If all of them
// freeze, ONE additional last-resort capture runs with skipFreezeCheck so
// the pipeline always commits frames to disk for stitch — making the
// real worst case MAX_CAPTURE_ATTEMPTS + 1 captureOne invocations.
async function captureWithRetry(browser, aspect, clip) {
  for (let attempt = 1; attempt <= MAX_CAPTURE_ATTEMPTS; attempt++) {
    const result = await captureOne(browser, aspect, clip);
    if (!result.freezeDetected) return result;
    if (attempt < MAX_CAPTURE_ATTEMPTS) {
      console.warn(`    ⚠ freeze ${result.maxFreezeMs.toFixed(0)}ms > ${result.threshold}ms — retry ${attempt}/${MAX_CAPTURE_ATTEMPTS - 1}`);
    } else {
      console.warn(`    ⚠ freeze persists after ${MAX_CAPTURE_ATTEMPTS} attempts — shipping the last one anyway`);
      // Last-resort capture: skip the freeze check so we always commit
      // frames to disk regardless of staleness. Without this, a 4th attempt
      // that also freezes would rmSync its own targetDir and stitch would
      // bail with "missing inputs" — defeating the "ship anyway" intent.
      return await captureOne(browser, aspect, clip, { skipFreezeCheck: true });
    }
  }
}

// Scan an array of {t, path} source frames and return the longest run of
// byte-identical consecutive frames in milliseconds, measured by their
// CDP wall-clock timestamps. Hashing is cheap (~50MB of JPEGs at SCALE=2,
// md5 throughput on modern hardware ~500MB/s = sub-second per clip).
function detectMaxFreezeMs(frames) {
  if (frames.length < 2) return 0;
  let maxMs = 0;
  let runStart = 0;
  let prevHash = hashFile(frames[0].path);
  for (let i = 1; i < frames.length; i++) {
    const hash = hashFile(frames[i].path);
    if (hash !== prevHash) {
      const runMs = (frames[i - 1].t - frames[runStart].t) * 1000;
      if (runMs > maxMs) maxMs = runMs;
      runStart = i;
      prevHash = hash;
    }
  }
  const tailMs = (frames[frames.length - 1].t - frames[runStart].t) * 1000;
  if (tailMs > maxMs) maxMs = tailMs;
  return maxMs;
}

function hashFile(p) {
  return crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
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
  const proc = spawn('node', [path.resolve(__dirname, '..', '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (chunk) => process.stderr.write('[server] ' + chunk));
  // waitForServer() polls /health AND proc.exitCode for readiness — much
  // sturdier than parsing stdout for a magic "running on" string, and
  // surfaces a server crash immediately instead of waiting the full timeout.
  return proc;
}

async function waitForServer(port, proc, timeoutMs = 10000) {
  const url = `http://localhost:${port}/health`;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // Fail-fast on a server crash. proc.exitCode flips to a non-null value
    // the moment the child exits; without this check, a startup error
    // (port in use, missing dep, syntax error) would burn the full
    // timeoutMs before reporting a misleading "did not respond" message.
    if (proc && proc.exitCode != null) {
      throw new Error(`Server exited early (code ${proc.exitCode}) before /health became reachable`);
    }
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
