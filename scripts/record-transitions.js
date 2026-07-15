'use strict';

// Records the display transition tour (?scenario=transitions) to an mp4 so
// screen/overlay transitions can be reviewed frame by frame at real speed.
//
// Boots its own SERVE_BUNDLES server on a free port (run `npm run build`
// first; the npm script chains it), opens the tour with autoplay=1, and
// stops when the tour lands back on the lobby. Playwright's built-in
// recorder writes a webm in real time; ffmpeg then converts it to H.264
// mp4 (the webm is kept as-is if ffmpeg isn't installed).
//
// This is deliberately lighter than the ad-clip pipeline (artwork/ad-clip):
// no supersampling, no time-scaling, no freeze retries. The tour is watched
// for judgment calls on motion, not shipped, so the recorder's native
// real-time capture is the point.
//
// Usage:
//   npm run record:transitions                    # 1280x720, 4 players, 1x
//   npm run record:transitions -- --ascale=3      # slow-motion transitions
//   node scripts/record-transitions.js --players=8 --size=1920x1080
//
// Flags: --tscale --ascale --players --lang --size=WxH --out=file.mp4
// Output: recordings/transitions-<stamp>.mp4 (gitignored; timestamped so
// successive renders can be compared side by side).

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { chromium } = require('@playwright/test');

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function spawnServer(port) {
  const proc = spawn('node', [path.resolve(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(port), SERVE_BUNDLES: '1' },
    stdio: ['ignore', 'inherit', 'pipe'],
  });
  proc.stderr.on('data', (chunk) => process.stderr.write('[server] ' + chunk));
  return proc;
}

async function waitForServer(port, proc, timeoutMs = 10000) {
  const url = `http://localhost:${port}/health`;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (proc.exitCode != null) {
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

async function main() {
  const tscale = parseFloat(arg('tscale', '1')) || 1;
  const ascale = parseFloat(arg('ascale', '1')) || 1;
  const players = arg('players', '4');
  const lang = arg('lang', 'en');
  const [width, height] = arg('size', '1280x720').split('x').map(Number);
  if (!width || !height) throw new Error('bad --size, expected WxH (e.g. 1920x1080)');
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const out = path.resolve(arg('out', path.join('recordings', `transitions-${stamp}.mp4`)));

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transitions-rec-'));
  let server = null;
  let browser = null;
  let webm = null;
  try {
    const port = await freePort();
    console.log(`Spawning server on port ${port}…`);
    server = spawnServer(port);
    await waitForServer(port, server);

    const params = new URLSearchParams({
      test: '1', bg: '1', lang, scenario: 'transitions',
      players, host: '0', autoplay: '1',
    });
    if (tscale !== 1) params.set('tscale', String(tscale));
    if (ascale !== 1) params.set('ascale', String(ascale));
    const url = `http://localhost:${port}/?${params}`;

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width, height },
      recordVideo: { dir: tmpDir, size: { width, height } },
    });
    const page = await context.newPage();
    page.on('pageerror', (err) => console.warn(`  [pageerror] ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.warn(`  [console.error] ${msg.text()}`);
    });

    console.log(`Recording ${width}×${height} @ tscale=${tscale} ascale=${ascale} players=${players}…`);
    await page.goto(url, { timeout: 10000 });

    // Tour-end detection: the lobby shows once mid-tour (welcome → lobby),
    // hides for the two matches, and comes back on the final NEW GAME press.
    // Waiting out that visible → hidden → visible cycle needs no knowledge
    // of the tour's absolute timings, so tscale/ascale don't affect it
    // beyond the timeout budget (~50s tour at 1x, scaled generously).
    const budget = Math.round(90000 * Math.max(tscale, ascale, 1));
    const lobbyHidden = (want) => page.waitForFunction(
      (w) => document.getElementById('lobby-screen').classList.contains('hidden') === w,
      want, { timeout: budget, polling: 100 }
    );
    await lobbyHidden(false);
    await lobbyHidden(true);
    await lobbyHidden(false);
    // Tail: let the lobby entrance stagger (~1.1s of delayed fades) settle
    // on film before the cut.
    await page.waitForTimeout(2000 * ascale);

    const video = page.video();
    await context.close();
    webm = await video.path();
  } finally {
    if (browser) await browser.close();
    if (server) server.kill('SIGTERM');
  }

  fs.mkdirSync(path.dirname(out), { recursive: true });
  const ff = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', webm,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'medium',
    '-movflags', '+faststart',
    out,
  ], { stdio: 'inherit' });
  if (ff.error || ff.status !== 0) {
    const keep = out.replace(/\.mp4$/, '.webm');
    fs.copyFileSync(webm, keep);
    console.warn(`ffmpeg unavailable or failed; kept the raw recording → ${path.relative(process.cwd(), keep)}`);
  } else {
    console.log(`Recorded → ${path.relative(process.cwd(), out)}`);
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
