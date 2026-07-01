// Measure the bounding box of non-background content in a screenshot, and
// report it against the screen bounds and the tvOS title-safe area. Used to
// detect clipping (content at/over the edges) and to gauge how much of the
// screen the boards actually use. Usage: node content-bounds.mjs <png> [scale]
//   scale: device-pixel scale (default 2 — a 1920x1080 pt screen is 3840x2160 px)
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const [path, scaleArg] = process.argv.slice(2);
const scale = Number(scaleArg) || 2;
const png = PNG.sync.read(readFileSync(path));
const { width: W, height: H, data } = png;

// Background = bg.primary (#1E1A2B). Treat a pixel as content if it differs
// from bg by more than `thresh` in summed channel distance.
const BG = [0x1e, 0x1a, 0x2b];
const thresh = 24;
let minX = W, minY = H, maxX = -1, maxY = -1, count = 0;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (W * y + x) << 2;
    const d = Math.abs(data[i] - BG[0]) + Math.abs(data[i + 1] - BG[1]) + Math.abs(data[i + 2] - BG[2]);
    if (d > thresh) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      count++;
    }
  }
}

const safe = { left: 80 * scale, right: 80 * scale, top: 60 * scale, bottom: 60 * scale };
const pt = (px) => (px / scale).toFixed(1);
console.log(`image: ${W}x${H} px  (=${W / scale}x${H / scale} pt @${scale}x)`);
console.log(`content px:  x[${minX}..${maxX}] y[${minY}..${maxY}]  (${count} px)`);
console.log(`content pt:  x[${pt(minX)}..${pt(maxX)}] y[${pt(minY)}..${pt(maxY)}]  w=${pt(maxX-minX)} h=${pt(maxY-minY)}`);
console.log(`margins pt:  left=${pt(minX)} right=${pt(W-maxX)} top=${pt(minY)} bottom=${pt(H-maxY)}`);
console.log(`safe area pt: left=${safe.left/scale} right=${safe.right/scale} top=${safe.top/scale} bottom=${safe.bottom/scale}`);
const clipScreen = minX <= 1 || minY <= 1 || maxX >= W - 2 || maxY >= H - 2;
const insideSafe = minX >= safe.left - 2 && minY >= safe.top - 2 && maxX <= W - safe.right + 2 && maxY <= H - safe.bottom + 2;
console.log(`touches screen edge (clipped): ${clipScreen ? 'YES' : 'no'}`);
console.log(`fully inside title-safe area:  ${insideSafe ? 'yes' : 'NO'}`);
