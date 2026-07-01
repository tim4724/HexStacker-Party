// Capture the web display reference screens (the same states the tvOS gallery
// renders) using the production display test harness, for side-by-side gap
// review. Writes scripts/gallery/shots/web/<state>.png at 1920x1080.
//
// Usage:
//   node capture-web.mjs <baseURL>      e.g. node capture-web.mjs http://localhost:8770
//
// Requires a running server (node server/index.js) serving the repo, and
// Playwright (`npx playwright install chromium` once). Best-effort: if
// Playwright is unavailable the tvOS-only gallery still works.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

const base = (process.argv[2] || 'http://localhost:8770').replace(/\/$/, '');
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'shots', 'web');
mkdirSync(outDir, { recursive: true });

// Map each gallery state to its harness scenario + params. Mirrors the tvOS
// HEXSHOT states; web-only/N-A states are simply omitted.
const STATES = [
  { name: 'lobby',                scenario: 'lobby',         params: { host: 0 } },
  { name: 'lobby-2p',             scenario: 'lobby',         params: { host: 0 }, players: 2 },
  { name: 'lobby-8p',             scenario: 'lobby',         params: { host: 0 }, players: 8 },
  { name: 'countdown',            scenario: 'countdown',     params: {} },
  { name: 'game',                 scenario: 'effects-combo', params: { level: 1 } },
  { name: 'game-lv8',             scenario: 'effects-combo', params: { level: 8 } },
  { name: 'game-lv12',            scenario: 'effects-combo', params: { level: 12 } },
  { name: 'pause',                scenario: 'pause',         params: { host: 0 } },
  { name: 'reconnecting',         scenario: 'reconnecting',  params: {} },
  { name: 'disconnected-display', scenario: 'disconnected',  params: { host: 0 } },
  { name: 'results',              scenario: 'results',       params: { host: 0 } },
  { name: 'results-solo',         scenario: 'results',       params: { host: 0 }, players: 1 },
];

function url(s) {
  const p = new URLSearchParams({ test: '1', bg: '1', lang: 'en', scenario: s.scenario,
                                  players: String(s.players ?? 4), level: '1' });
  for (const [k, v] of Object.entries(s.params)) p.set(k, String(v));
  return `${base}/?${p.toString()}`;
}

let chromium;
try { ({ chromium } = await import('playwright')); }
catch { console.error('playwright not installed — skipping web capture (run: npx playwright install chromium)'); process.exit(2); }

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
for (const s of STATES) {
  await page.goto(url(s), { waitUntil: 'networkidle' });
  // Animated states settle a touch slower; give them all a fixed beat.
  await page.waitForTimeout(s.scenario === 'effects-combo' ? 1400 : 700);
  await page.screenshot({ path: join(outDir, `${s.name}.png`) });
  console.log('  captured', s.name);
}
await browser.close();
console.log('done ->', outDir);
