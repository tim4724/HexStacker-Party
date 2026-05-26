// Ad-clip composite orchestrator. Loads the display + 4 controller iframes,
// waits for each to signal readiness, then runs the named clip module
// against them. Sets window.__AD_CLIP_DONE__ when the timeline ends so the
// Node-side capture knows when to close the recording context.

const params = new URLSearchParams(window.location.search);
const CLIP = params.get('clip') || 'lobby-reveal';
const ASPECT = params.get('aspect') === '9x16' ? '9x16' : '16x9';
const SEED = parseInt(params.get('seed'), 10) || 42;
// Forwarded from capture.js so card-style clips (logo, winner) can size
// their hold-time to the slot the variant allocated. 0 means unset.
const DURATION_MS = parseInt(params.get('duration'), 10) || 0;
// Game-speed multiplier applied via patched performance.now / Date.now.
// 1 = real time. 0.5 = half speed (browser has 2× wall-time per game-frame),
// improves capture quality at high SCALE. Patching happens just before GO.
const TIME_SCALE = parseFloat(params.get('timeScale')) || 1;
const PLAYER_COUNT = 4;
// Total phones we mount up front. The 8-player clip slides in slots 4-7
// so they have to exist (and be ready) before recording starts; other
// clips keep them off-screen.
const TOTAL_PHONES = 8;
// Phone labels match the controller's FAKE_NAMES[colorIdx] anyway — the
// URL `name=` param is here so the labels stay in sync if those defaults
// ever change. Order matches the lobby's player-card order.
const PHONE_NAMES = ['Emma', 'Jake', 'Sofia', 'Liam', 'Mia', 'Noah', 'Ava', 'Leo'];

document.body.classList.add(`aspect-${ASPECT}`);
document.body.classList.add(`clip-${CLIP}`);

const stage = document.getElementById('stage');
const displayIframe = document.getElementById('display-iframe');
const phonesEl = document.getElementById('phones');
const titleCard = document.getElementById('title-card');

// --- Display URL: the lobby-reveal clip mounts the lobby with ZERO
// players so the clip module can pop them in one-by-one in the captured
// timeline. Other clips bypass the lobby entirely and boot the local
// game inside their own stage().
function displayURL() {
  if (CLIP === 'lobby-reveal') {
    return `/?adclip=1&scenario=lobby&players=0&seed=${SEED}`;
  }
  return `/?adclip=1&seed=${SEED}`;
}

displayIframe.src = displayURL();

// Hide the START button in the lobby clip — the simulated-press animation
// reads as "weird" in the trailer (button just turns red briefly with no
// continuation). visibility:hidden (not display:none) so it still occupies
// its slot in the layout flow — without it the lobby content reflows
// upward and the visual balance shifts. The lobby-reveal clip module
// still runs the press for timing purposes; nothing's visible.
if (CLIP === 'lobby-reveal') {
  displayIframe.addEventListener('load', () => {
    const doc = displayIframe.contentDocument;
    if (!doc || !doc.head) return;
    const style = doc.createElement('style');
    style.textContent = '#start-btn { visibility: hidden !important; }';
    doc.head.appendChild(style);
  });
}

// --- Build phone iframes ---
const phones = [];
for (let i = 0; i < TOTAL_PHONES; i++) {
  const phone = document.createElement('div');
  phone.className = 'phone';
  // Slots 4-7 are "extras" that only appear in the 8p chaos clip.
  if (i >= PLAYER_COUNT) phone.classList.add('phone--extra');
  phone.dataset.slot = String(i);

  const notch = document.createElement('div');
  notch.className = 'phone__notch';

  const screen = document.createElement('div');
  screen.className = 'phone__screen';

  const iframe = document.createElement('iframe');
  iframe.title = `Controller ${i + 1}`;
  iframe.referrerPolicy = 'no-referrer';
  iframe.src = `/controller/index.html?scenario=adclip&color=${i}&name=${encodeURIComponent(PHONE_NAMES[i])}&players=${TOTAL_PHONES}&seed=${SEED + i}`;
  screen.appendChild(iframe);

  phone.appendChild(notch);
  phone.appendChild(screen);
  phonesEl.appendChild(phone);
  phones.push({ wrapper: phone, iframe });
}

// --- Ready handshake ---
const readyState = { display: false, controllers: new Set() };
let readyResolve;
const readyPromise = new Promise((r) => { readyResolve = r; });

function checkReady() {
  if (readyState.display && readyState.controllers.size === TOTAL_PHONES) {
    readyResolve();
  }
}

window.addEventListener('message', (e) => {
  const msg = e.data;
  if (!msg || msg.type !== 'adclip-ready') return;
  if (msg.role === 'display') {
    readyState.display = true;
  } else if (msg.role === 'controller') {
    readyState.controllers.add(msg.color);
  }
  checkReady();
});

// --- Run clip ---
async function run() {
  // Race against a timeout so a controller iframe that fails to send
  // adclip-ready (JS error, sandbox rejection, etc.) surfaces *which* slot
  // never reported instead of a generic 15s waitForFunction failure upstream.
  const readyTimeout = new Promise((_, rej) => setTimeout(() => {
    const missing = [];
    if (!readyState.display) missing.push('display');
    for (let i = 0; i < TOTAL_PHONES; i++) {
      if (!readyState.controllers.has(i)) missing.push(`controller-${i}`);
    }
    rej(new Error(`adclip-ready timeout — never received from: ${missing.join(', ')}`));
  }, 12000));
  await Promise.race([readyPromise, readyTimeout]);
  document.body.classList.remove('loading');

  // Slot 0-3 are visible from the start of every non-lobby clip (the lobby
  // animates them in itself). Slots 4-7 only appear in chaos8p, which adds
  // .in to them inside its own clip module.
  if (CLIP !== 'lobby-reveal') {
    for (let i = 0; i < PLAYER_COUNT; i++) phones[i].wrapper.classList.add('in');
  }

  await wait(150);
  const clipModule = await import(`./clips/${clipFileFor(CLIP)}.js`);

  const ctx = {
    display: displayIframe.contentWindow,
    controllers: phones.map((p) => p.iframe.contentWindow),
    phones,
    titleCard,
    clip: CLIP,
    aspect: ASPECT,
    seed: SEED,
    playerCount: PLAYER_COUNT,
    durationMs: DURATION_MS
  };

  // Stage the scene BEFORE recording starts — bootLocalGame, prefilled
  // boards, results screen, etc. all happen here so the iframe never
  // shows its welcome/lobby intermediate state when the screencast goes
  // live. Without this, every clip cut briefly flashes the HEX STACKER
  // title that the display defaults to before bootLocalGame transitions.
  await clipModule.stage(ctx);
  // Two RAFs to make sure the canvas paints the staged scene before we
  // hand control to capture.js.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  // Tell the capture harness the scene is staged. Capture.js starts its
  // screencast in response, then writes __AD_CLIP_GO__ when the recorder
  // is live so the animation begins inside the captured timeline.
  window.__AD_CLIP_READY__ = true;
  while (!window.__AD_CLIP_GO__) {
    await new Promise((r) => requestAnimationFrame(() => r()));
  }

  // Apply time-scale right before clip start so staging is unaffected.
  // Patching both this window AND the display iframe's window — same-origin
  // so we can reach into it. Canvas-based animations (the game's renderer)
  // and JS that reads perf.now (gameplay-clip's AI loop, displayGame's
  // update tick) all follow the slowdown. CSS animations don't.
  if (TIME_SCALE !== 1) {
    applyTimeScale(window);
    if (displayIframe.contentWindow) applyTimeScale(displayIframe.contentWindow);
  }

  window.__AD_CLIP_T_START__ = performance.now();
  await clipModule.run(ctx);
  window.__AD_CLIP_T_END__ = performance.now();
  // Hold the final scene a few frames so the closing cut doesn't slice
  // into the last animation frame.
  await wait(120);
  window.__AD_CLIP_DONE__ = true;
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Patch performance.now / Date.now / requestAnimationFrame on the given
// window so the in-page clock advances at TIME_SCALE × wall-clock.
// Patching RAF as well as the time sources is critical: the display's
// renderLoop computes engine deltaMs from RAF's timestamp argument, so
// without this patch the engine would keep ticking at full wall-clock
// rate while AI dispatch (which uses perf.now) ran at scaled rate — the
// resulting pace mismatch caused pieces to auto-lock before plans
// completed, leading to back-half hangs on slower-paced clips.
// Idempotent: marked after first patch so calling twice is a no-op.
function applyTimeScale(win) {
  if (win.__AD_TIME_PATCHED__) return;
  win.__AD_TIME_PATCHED__ = true;
  const origPerf = win.performance.now.bind(win.performance);
  const origDate = win.Date.now.bind(win.Date);
  const origRAF = win.requestAnimationFrame.bind(win);
  const startPerf = origPerf();
  const startDate = origDate();
  const scalePerf = (t) => startPerf + (t - startPerf) * TIME_SCALE;
  win.performance.now = () => scalePerf(origPerf());
  win.Date.now = () => startDate + (origDate() - startDate) * TIME_SCALE;
  win.requestAnimationFrame = (cb) => origRAF((timestamp) => cb(scalePerf(timestamp)));
}

// Standalone clip files have their own module; everything else routes to
// gameplay-clip which keys per-tier config off the clip name. Unknown names
// throw — the silent chaos8p fallback used to hide typos in the capture log.
const STANDALONE_CLIPS = new Set(['lobby-reveal', 'winner', 'logo']);
const GAMEPLAY_CLIPS = new Set(['normal4p', 'pillow4p', 'neon4p', 'chaos8p']);
function clipFileFor(name) {
  if (STANDALONE_CLIPS.has(name)) return name;
  if (GAMEPLAY_CLIPS.has(name)) return 'gameplay-clip';
  throw new Error(`Unknown clip "${name}". Known: ${[...STANDALONE_CLIPS, ...GAMEPLAY_CLIPS].join(', ')}`);
}

run().catch((err) => {
  console.error('[ad-clip] run failed:', err);
  // Set done so the capture script won't hang forever; the resulting clip
  // will be obviously broken and easy to spot.
  window.__AD_CLIP_DONE__ = true;
  window.__AD_CLIP_ERROR__ = String(err && err.stack || err);
});
