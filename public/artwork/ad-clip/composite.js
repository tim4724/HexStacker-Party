// Ad-clip composite orchestrator. Loads the display + 4 controller iframes,
// waits for each to signal readiness, then runs the named clip module
// against them. Sets window.__AD_CLIP_DONE__ when the timeline ends so the
// Node-side capture knows when to close the recording context.

const params = new URLSearchParams(window.location.search);
const CLIP = params.get('clip') || 'lobby-reveal';
const ASPECT = params.get('aspect') === '9x16' ? '9x16' : '16x9';
const SEED = parseInt(params.get('seed'), 10) || 42;
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
  await readyPromise;
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
    playerCount: PLAYER_COUNT
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

  window.__AD_CLIP_T_START__ = performance.now();
  await clipModule.run(ctx);
  window.__AD_CLIP_T_END__ = performance.now();
  // Hold the final scene a few frames so the closing cut doesn't slice
  // into the last animation frame.
  await wait(120);
  window.__AD_CLIP_DONE__ = true;
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

function clipFileFor(name) {
  if (name === 'lobby-reveal' || name === 'winner') return name;
  return 'gameplay-clip';
}

run().catch((err) => {
  console.error('[ad-clip] run failed:', err);
  // Set done so the capture script won't hang forever; the resulting clip
  // will be obviously broken and easy to spot.
  window.__AD_CLIP_DONE__ = true;
  window.__AD_CLIP_ERROR__ = String(err && err.stack || err);
});
