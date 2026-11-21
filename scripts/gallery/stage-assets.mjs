// Copies every local file the gallery pages (gallery*.html in DIR) reference
// that DIR lacks: the /gallery-assets/* images, whose URL path is their repo
// path, and the files the app bundles otherwise replace (theme CSS/JS, engine
// modules), resolved as the dev server does. DIR is site/ (npm run build:site)
// or the TV-gallery pod's webshell. Sources missing from the checkout
// (gitignored local art) are skipped; those cards show "not generated".

import { readFileSync, existsSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const { resolveAsset } = createRequire(import.meta.url)('../asset-manifest.js');
const DIR = process.argv[2] || 'scripts/gallery/webshell';
const ASSETS = '/gallery-assets/';

const pages = readdirSync(DIR).filter((f) => f.startsWith('gallery') && f.endsWith('.html'));
const urls = new Set();
for (const page of pages) {
  const html = readFileSync(join(DIR, page), 'utf8');
  for (const m of html.matchAll(/(?:src|href)="(\/[^"?#]+)/g)) urls.add(m[1]);
}

let staged = 0;
for (const url of [...urls].sort()) {
  const file = decodeURIComponent(url);
  const dst = join(DIR, file);
  if (existsSync(dst)) continue;
  const src = file.startsWith(ASSETS) ? file.slice(ASSETS.length) : resolveAsset(file);
  if (!existsSync(src)) {
    console.log(`gallery: no source for '${url}' (skipped)`);
    continue;
  }
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  staged++;
}
console.log(`gallery: staged ${staged} file(s) for ${pages.length} page(s) into ${DIR}`);
