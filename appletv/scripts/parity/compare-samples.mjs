// Cross-engine VISUAL parity: compares the web canvas render against the native
// tvOS render for the shared fixture, cell by cell. The web pixel samples are
// passed in as JSON (read from the live canvas via the MCP browser, since its
// filesystem is isolated); the native samples are read from the native PNG.
// Each engine's sampled color is classified to the nearest PIECE_COLOR and must
// equal the fixture's expected type, and the two engines must agree.
//
// Usage: node compare-samples.mjs <nativePng> '<webSamplesJSON>'
//   webSamplesJSON: [[col,x,y,r,g,b], ...] sampled at the same cell centers,
//   in the SAME pixel space as the native PNG (board top-left origin, scale 1).
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const PIECE_COLORS = {
  1: [0xFF, 0x6B, 0x6B], 2: [0x4E, 0xCD, 0xC4], 3: [0xFF, 0xE0, 0x66],
  4: [0xA7, 0x8B, 0xFA], 5: [0x7B, 0xED, 0x6F], 6: [0xF1, 0x78, 0xD8],
  9: [0x80, 0x80, 0x80],
};
// Fixture bottom row by column, read from fixture.json so the expected row
// can't drift from what the renderers were told to draw.
const EXPECTED = JSON.parse(
  readFileSync(new URL('./fixture.json', import.meta.url), 'utf8')
).grid.at(-1);

function nearest([r, g, b]) {
  let best = -1, bestD = Infinity;
  for (const [id, [pr, pg, pb]] of Object.entries(PIECE_COLORS)) {
    const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
    if (d < bestD) { bestD = d; best = +id; }
  }
  return best;
}

const [nativePath, webJson] = process.argv.slice(2);
const web = JSON.parse(webJson); // [[col,x,y,r,g,b],...]
const png = PNG.sync.read(readFileSync(nativePath));
function nativePixel(x, y) {
  const i = (png.width * y + x) << 2;
  return [png.data[i], png.data[i + 1], png.data[i + 2]];
}

let fails = 0;
console.log('col  exp   web(rgb)->id        native(rgb)->id       match');
for (const [col, x, y, r, g, b] of web) {
  const exp = EXPECTED[col];
  const webId = nearest([r, g, b]);
  const nrgb = nativePixel(x, y);
  const natId = nearest(nrgb);
  const ok = webId === exp && natId === exp && webId === natId;
  if (!ok) fails++;
  const pad = (s, n) => String(s).padEnd(n);
  console.log(
    `${pad(col, 4)} ${pad(exp, 5)} ${pad(`[${r},${g},${b}]`, 14)}->${pad(webId, 3)} ` +
    `${pad(`[${nrgb.join(',')}]`, 16)}->${pad(natId, 3)} ${ok ? 'OK' : 'FAIL'}`
  );
}
const total = web.length;
console.log(`\n${total - fails}/${total} cells agree (web == native == expected)`);
process.exit(fails === 0 ? 0 : 1);
