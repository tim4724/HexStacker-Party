# Cross-engine VISUAL parity test (web vs. native tvOS)

Renders one fixed engine snapshot with **both** renderers and compares the
on-screen block colors cell-by-cell. The web side reuses the production modules
(`server/constants.js`, `public/shared/theme.js`, `public/shared/CanvasUtils.js`,
`public/display/BoardRenderer.js`); the native side must draw the same fixture
at `cellSize = 40`.

## Files

| File | Role |
| --- | --- |
| `fixture.json` | The shared engine snapshot. 15x9 grid, all zeros except the bottom row (index 14) = `[1,2,3,4,5,6,9,1,2]`. No active/ghost/hold piece. Both renderers draw exactly this. |
| `render-web.html` | Standalone page: loads the engine/theme/renderer via relative `../../../` `<script>` tags, draws the inlined fixture onto a `360x691` canvas with `new BoardRenderer(ctx, 0, 0, 40, 0)`, then sets `window.__READY = true`. |
| `visual-compare.mjs` | Node ESM. Samples each bottom-row cell center in both PNGs, classifies to the nearest `PIECE_COLOR`, and asserts it matches the fixture. Exits `1` on any misclassification. |

## Exact geometry — `computeHexGeometry(9, 15, 40)`

The native side **must** reproduce these so `cellSize = 40` lines up:

```
hexSize     = 25.714285714285715      (= 9*40 / (1.5*9 + 0.5) = 360/14)
hexH        = 44.53844933748542       (= sqrt(3) * hexSize)
colW        = 38.57142857142857       (= 1.5 * hexSize)
boardWidth  = 360                      (= colW*(9-1) + 2*hexSize)            -> canvas width  ceil(360) = 360
boardHeight = 690.345964731024         (= hexH*(15-1) + hexH + hexH*0.5)     -> canvas height ceil(...) = 691
```

Bottom-row (row 14) cell centers, board-local pixels
(`x = colW*col + hexSize`, `y = hexH*(row + 0.5*(col&1)) + hexH/2`):

```
col 0  type 1 (red)      x=25.714  y=645.808
col 1  type 2 (teal)     x=64.286  y=668.077
col 2  type 3 (honey)    x=102.857 y=645.808
col 3  type 4 (violet)   x=141.429 y=668.077
col 4  type 5 (mint)     x=180.000 y=645.808
col 5  type 6 (magenta)  x=218.571 y=668.077
col 6  type 9 (garbage)  x=257.143 y=645.808
col 7  type 1 (red)      x=295.714 y=668.077
col 8  type 2 (teal)     x=334.286 y=645.808
```

Odd columns are offset down by `hexH/2` (flat-top hex zigzag). `PIECE_COLORS`:
`1=#FF6B6B 2=#4ECDC4 3=#FFE066 4=#A78BFA 5=#7BED6F 6=#F178D8 9=#808080`.

## Steps

### 1. Serve the repo

Pick a free, unique port (other worktrees/agents serve concurrently). Example
uses `8753`. Serve from the **repo root** so the `../../../` script paths in
`render-web.html` resolve.

```bash
# from the repo root: /Users/tim/emdash/worktrees/HexStacker-Party/emdash/apple-tv-rl1im
python3 -m http.server 8753
# or:  node server/index.js   (then use that server's port + path)
```

Page URL: `http://localhost:8753/appletv/scripts/parity/render-web.html`

### 2. Capture the web render to `web.png`

Use `deviceScaleFactor: 1` so the screenshot is 1:1 with the canvas
(`360x691`) — that makes the compare mapping `origin=(0,0)`, `scale=1`.
Screenshot the **canvas element only** so the PNG is exactly the board.

```bash
# one-time, if needed:  npm i -D playwright && npx playwright install chromium
node - <<'NODE'
import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
await page.goto('http://localhost:8753/appletv/scripts/parity/render-web.html');
await page.waitForFunction('window.__READY === true');
const canvas = await page.locator('#board');
await canvas.screenshot({ path: 'appletv/scripts/parity/web.png' });
await browser.close();
console.log('wrote appletv/scripts/parity/web.png');
NODE
```

(Equivalent with the Playwright MCP tools: `browser_navigate` to the URL,
`browser_wait_for`/`browser_evaluate` until `window.__READY === true`, then
`browser_take_screenshot` of the `#board` element.)

### 3. Capture the native render to `native.png`

Have the tvOS app draw `fixture.json` at `cellSize = 40` and grab a screenshot
(the HEXSNAP capture). For a like-for-like compare, crop/normalize it so the
board's top-left corner is the PNG origin and it is at scale 1
(i.e. `360x691`). If the native capture is retina (e.g. `720x1382`), either
downscale the crop to `360x691`, or pass a matching `scale` **only if the web
PNG was captured at the same scale** — `visual-compare.mjs` applies one mapping
to both images.

### 4. Compare

Args: `<webPng> <nativePng> <cellSize> <originXpx> <originYpx> <scale>`.
For matched 1:1 crops:

```bash
# from the repo root
node appletv/scripts/parity/visual-compare.mjs \
  appletv/scripts/parity/web.png \
  appletv/scripts/parity/native.png \
  40 0 0 1
```

`pngjs` is required. If it is not installed, either `npm i pngjs`, or run the
script with it provided ad hoc:

```bash
npx --yes --package pngjs node appletv/scripts/parity/visual-compare.mjs \
  appletv/scripts/parity/web.png appletv/scripts/parity/native.png 40 0 0 1
```

Output is per-cell `PASS/FAIL` (with the sampled RGB and classified id for each
engine) plus an overall percentage. The process exits `1` if any cell in either
image misclassifies, so it can gate CI.

### Self-check (web-only) while the native PNG is not ready yet

Pass `web.png` as both arguments to confirm the web side classifies correctly
and the mapping/geometry are right before the native capture exists:

```bash
node appletv/scripts/parity/visual-compare.mjs \
  appletv/scripts/parity/web.png appletv/scripts/parity/web.png 40 0 0 1
```

## Verified result (web canvas vs native tvOS)

Captured the web render (this page) and the native render (the tvOS app launched
with `HEXSNAP=1`) of the shared fixture and compared the bottom-row cell colors:

```
col exp  web(rgb)->id     native(rgb)->id   match
0   1    [242,109,109]->1 [242,109,109]->1  OK
1   2    [80,210,200] ->2 [80,210,200] ->2  OK
...
6   9    [131,131,131]->9 [130,130,130]->9  OK   (within 1 of rasterizer rounding)
8   2    [80,210,200] ->2 [80,210,200] ->2  OK
```
**9/9 cells agree (web == native == expected).** The two renderers produce
near-identical pixels, confirming the SpriteKit port matches the web canvas.

### Two ways to run the comparison

- `compare-samples.mjs` (used above): web pixels sampled live from the canvas via
  `getImageData` (robust when the browser's filesystem is isolated, e.g. the MCP
  Playwright bridge), native pixels read from the PNG. Run:
  `node compare-samples.mjs native.png '<webSamplesJSON>'`
- `visual-compare.mjs`: classic two-PNG diff (web.png + native.png) when you can
  save both screenshots to disk. See steps above.

Native capture: launch the app with `SIMCTL_CHILD_HEXSNAP=1 xcrun simctl launch
<device> com.hexstacker.HexStackerTV`, screenshot, downscale x0.5 to scale 1.
Dependencies: `cd appletv/scripts/parity && npm i` (pngjs).
