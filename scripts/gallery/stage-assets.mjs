// Stage the assets the gallery pages reference via /gallery-assets/* into the
// TV-gallery pod's webshell, so the pod serves them: Traefik's /gallery
// PathPrefix routes those requests to this pod, and the game image ships none
// of the tvOS/Android/artwork source dirs the artwork gallery draws from.
//
// Driven by the pages themselves — every /gallery-assets/<path> reference is
// parsed out and its committed source copied to the matching path — so adding a
// gallery asset never needs a change here. Sources that don't exist in the
// checkout (gitignored local previews like artwork/tvos-preview/*) are skipped;
// those cards fall back to the page's "not generated" hint.
import { readFileSync, existsSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const WEBSHELL = 'scripts/gallery/webshell';
const ROOT = join(WEBSHELL, 'gallery-assets');
const PREFIX = '/gallery-assets/';

const pages = readdirSync(WEBSHELL).filter((f) => f.startsWith('gallery') && f.endsWith('.html'));
const urls = new Set();
for (const page of pages) {
  const html = readFileSync(join(WEBSHELL, page), 'utf8');
  for (const m of html.matchAll(/\/gallery-assets\/[^"]+/g)) urls.add(m[0]);
}

let staged = 0;
for (const url of [...urls].sort()) {
  const rel = decodeURIComponent(url.slice(PREFIX.length));
  if (!existsSync(rel)) {
    console.log(`gallery-assets: no source for '${rel}' (skipped)`);
    continue;
  }
  const dst = join(ROOT, rel);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(rel, dst);
  staged++;
}
console.log(`gallery-assets: staged ${staged} file(s) from ${pages.length} page(s)`);
