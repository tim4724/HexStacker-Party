// Assemble scripts/gallery/gallery.html from the captured shots: one row per
// scenario in scenarios.json, three columns (web reference | tvOS | Android TV)
// for side-by-side gap review across every platform that renders the display.
// Run after any of capture-web.mjs / capture-tvos.sh / collect-shots.mjs; a
// platform that hasn't captured yet renders an explicit gap, not a silent skip.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const { scenarios } = JSON.parse(readFileSync(join(here, 'scenarios.json'), 'utf8'));

const PLATFORMS = [
  ['web', 'web reference'],
  ['tvos', 'tvOS'],
  ['android', 'Android TV'],
];

const shotPath = (platform, key) => join(here, 'shots', platform, `${key}.png`);

// Pick up any captured states not in the manifest, so nothing is silently dropped.
const known = new Set(scenarios.map((s) => s.key));
const rows = [...scenarios];
for (const [platform] of PLATFORMS) {
  const dir = join(here, 'shots', platform);
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.png'))) {
    const key = f.replace(/\.png$/, '');
    if (known.has(key)) continue;
    known.add(key);
    rows.push({ key, title: key, [platform]: {}, unlisted: true });
  }
}

const cell = (row, platform, label) => {
  const mapping = row[platform];
  const captured = existsSync(shotPath(platform, row.key));
  const note = mapping?.note ? `<span class="note">${mapping.note}</span>` : '';
  if (captured) {
    return `<figure><figcaption>${label}${note}</figcaption><img loading="lazy" src="shots/${platform}/${row.key}.png"></figure>`;
  }
  const why = mapping ? 'not captured' : 'no equivalent yet';
  return `<figure class="missing"><figcaption>${label}</figcaption><div class="none">${why}</div></figure>`;
};

const sections = rows
  .filter((row) => PLATFORMS.some(([p]) => row[p] || existsSync(shotPath(p, row.key))))
  .map((row) => {
    const cells = PLATFORMS.map(([p, label]) => cell(row, p, label)).join('');
    const flag = row.unlisted ? ' <span class="key">(not in scenarios.json)</span>' : '';
    return `<section class="state"><h2>${row.title} <span class="key">${row.key}</span>${flag}</h2><div class="trio">${cells}</div></section>`;
  })
  .join('\n');

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>HexStacker — TV screen gallery</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #15121f; color: #ece8f5;
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  header { padding: 28px 32px 8px; }
  header h1 { margin: 0 0 4px; font-size: 22px; letter-spacing: .02em; }
  header p { margin: 0; color: #9b93b4; }
  .legend { margin: 12px 32px 0; color: #9b93b4; font-size: 13px; }
  main { padding: 16px 32px 64px; display: flex; flex-direction: column; gap: 36px; }
  .state h2 { font-size: 16px; margin: 0 0 10px; font-weight: 600; letter-spacing: .02em; }
  .state h2 .key { color: #6f6790; font-weight: 400; font-size: 12px; margin-left: 8px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .trio { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; align-items: start; }
  figure { margin: 0; background: #1d1930; border: 1px solid #2c2742; border-radius: 12px; overflow: hidden; }
  figcaption { padding: 6px 10px; font-size: 12px; color: #9b93b4; border-bottom: 1px solid #2c2742;
    text-transform: uppercase; letter-spacing: .08em; }
  figcaption .note { float: right; text-transform: none; letter-spacing: 0; color: #6f6790; font-style: italic; }
  figure img { display: block; width: 100%; height: auto; background: #000; }
  figure.missing .none { display: grid; place-items: center; aspect-ratio: 16/9; color: #5c5578; font-style: italic; }
  @media (max-width: 1200px) { .trio { grid-template-columns: 1fr; } }
</style></head>
<body>
<header>
  <h1>HexStacker — TV screen gallery</h1>
  <p>Web reference vs native tvOS vs native Android TV, one row per display state. Regenerate after UI changes.</p>
</header>
<p class="legend">Scenarios: <code>scripts/gallery/scenarios.json</code>. Capture: <code>capture-web.mjs</code> (Playwright), <code>capture-tvos.sh</code> (Simulator), <code>collect-shots.mjs android</code> (Roborazzi). Assemble: <code>gen-gallery.mjs</code>. In CI the <code>tv-gallery</code> workflow builds this from the per-platform screenshot artifacts.</p>
<main>
${sections}
</main>
</body></html>
`;

const out = join(here, 'gallery.html');
writeFileSync(out, html);
console.log('wrote', out);
