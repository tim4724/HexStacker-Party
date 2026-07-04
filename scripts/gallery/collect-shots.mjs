// Normalize native screenshot output into shots/<platform>/<key>.png so
// gen-gallery.mjs (and the CI artifact) see one canonical name per scenario.
//
//   node collect-shots.mjs android [srcDir]   # Roborazzi PNGs (flat dir)
//   node collect-shots.mjs tvos [srcDir]      # xcparse output (recursive, uuid-suffixed)
//
// Default srcDir is where each toolchain drops its output locally:
//   android -> android/tv/build/outputs/roborazzi
//   tvos    -> appletv/screenshots            (xcparse; capture-tvos.sh writes
//                                              canonical names directly instead)
// Missing scenarios are reported but not fatal: the gallery renders the gap.
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const { scenarios } = JSON.parse(readFileSync(join(here, 'scenarios.json'), 'utf8'));

const DEFAULT_SRC = {
  android: join(root, 'android', 'tv', 'build', 'outputs', 'roborazzi'),
  tvos: join(root, 'appletv', 'screenshots'),
};

const platform = process.argv[2];
if (!(platform in DEFAULT_SRC)) {
  console.error('usage: node collect-shots.mjs <android|tvos> [srcDir]');
  process.exit(2);
}
const srcDir = process.argv[3] || DEFAULT_SRC[platform];
if (!existsSync(srcDir)) {
  console.error(`source dir not found: ${srcDir}`);
  process.exit(1);
}

const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const p = join(dir, name);
  return statSync(p).isDirectory() ? walk(p) : p.endsWith('.png') ? [p] : [];
});
const pngs = walk(srcDir);

// android: exact Roborazzi filename from the manifest.
// tvos: XCTAttachment name == canonical key, but xcparse may suffix it
// (`<key>_<n>_<uuid>.png`); an underscore suffix can't collide across keys
// because key variants use dashes (lobby vs lobby-2p).
const findFor = (s) => {
  if (platform === 'android') return pngs.find((p) => basename(p) === `${s.android.file}.png`);
  const exact = pngs.find((p) => basename(p) === `${s.key}.png`);
  return exact ?? pngs.find((p) => basename(p).startsWith(`${s.key}_`));
};

const outDir = join(here, 'shots', platform);
mkdirSync(outDir, { recursive: true });

let copied = 0;
for (const s of scenarios) {
  if (!s[platform]) continue;
  const src = findFor(s);
  if (!src) { console.warn(`  missing ${s.key} (no match in ${srcDir})`); continue; }
  copyFileSync(src, join(outDir, `${s.key}.png`));
  copied += 1;
}

// Carry the shot provenance (written into the artifact dir by the gallery
// workflow's lookup: "this commit", "main @ abc1234", …) so gen-gallery.mjs can
// label a reused column. Absent on local runs — the gallery just omits the note.
const provenance = join(srcDir, '.source');
if (existsSync(provenance)) copyFileSync(provenance, join(outDir, '.source'));

console.log(`collected ${copied} ${platform} shot(s) -> ${outDir}`);
