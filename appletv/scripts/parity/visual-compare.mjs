#!/usr/bin/env node
'use strict';

// Cross-engine VISUAL parity check.
//
// Samples the center pixel of every block in the fixture's bottom row from
// BOTH the web Canvas screenshot and the native tvOS (HEXSNAP) screenshot,
// classifies each sampled color to the nearest PIECE_COLOR (RGB euclidean),
// and asserts it matches the fixture's expected typeId. The web renderer
// shades blocks with gradients/highlights, so the exact center pixel is not
// the flat palette color - nearest-color classification absorbs that while
// still catching a wrong hue (e.g. teal drawn where red is expected).
//
// Usage:
//   node visual-compare.mjs <webPng> <nativePng> <cellSize> <originXpx> <originYpx> <scale>
//
// Mapping: a board-local center (bx, by) maps to a pixel via
//   px = bx * scale + originXpx
//   py = by * scale + originYpx
// The SAME mapping is applied to both PNGs, so capture both at the same board
// origin and scale (see README). For the web page rendered at cellSize=40 with
// deviceScaleFactor=1 and the canvas cropped tightly, pass: 40 0 0 1.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// --- Geometry: exact mirror of GameConstants.computeHexGeometry (server/constants.js) ---
function computeHexGeometry(boardCols, visRows, cellSize) {
  const hexSize = (boardCols * cellSize) / (1.5 * boardCols + 0.5);
  const hexH = Math.sqrt(3) * hexSize;
  const colW = 1.5 * hexSize;
  return {
    hexSize,
    hexH,
    colW,
    boardWidth: colW * (boardCols - 1) + 2 * hexSize,
    boardHeight: hexH * (visRows - 1) + hexH + hexH * 0.5,
  };
}

const COLS = 9;
const VISIBLE_ROWS = 15;

// --- Piece colors: exact mirror of theme.js PIECE_COLORS (drawable ids only) ---
const PIECE_COLORS = {
  1: '#FF6B6B', // I3  red
  2: '#4ECDC4', // V3  teal
  3: '#FFE066', // T3  honey
  4: '#A78BFA', // o   violet
  5: '#7BED6F', // d   mint
  6: '#F178D8', // b   magenta
  9: '#808080', // garbage  gray
};

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return m
    ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) }
    : null;
}

const PALETTE = Object.entries(PIECE_COLORS).map(([id, hex]) => {
  const rgb = hexToRgb(hex);
  return { id: Number(id), r: rgb.r, g: rgb.g, b: rgb.b };
});

function classify(r, g, b) {
  let best = PALETTE[0];
  let bestD = Infinity;
  for (const p of PALETTE) {
    const d = (r - p.r) ** 2 + (g - p.g) ** 2 + (b - p.b) ** 2;
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return { id: best.id, dist: Math.sqrt(bestD) };
}

// --- Fixture: bottom row only (row index 14), as defined in fixture.json ---
const BOTTOM_ROW_INDEX = VISIBLE_ROWS - 1; // 14
const BOTTOM_ROW = [1, 2, 3, 4, 5, 6, 9, 1, 2];

function loadPng(path) {
  let PNG;
  try {
    ({ PNG } = require('pngjs'));
  } catch (e) {
    console.error(
      'pngjs not found. Install it, then re-run:\n' +
        '  npm i pngjs\n' +
        'or run this script through npx with pngjs provided:\n' +
        '  npx --yes --package pngjs node ' + import.meta.url.replace('file://', '') + ' ...'
    );
    process.exit(2);
  }
  let buf;
  try {
    buf = readFileSync(path);
  } catch (e) {
    console.error('Cannot read PNG: ' + path + '  (' + e.message + ')');
    process.exit(2);
  }
  return PNG.sync.read(buf);
}

function sample(png, x, y) {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= png.width || yi >= png.height) return null;
  const idx = (yi * png.width + xi) * 4;
  return {
    r: png.data[idx],
    g: png.data[idx + 1],
    b: png.data[idx + 2],
    a: png.data[idx + 3],
  };
}

function fmtCell(px, py, s, c) {
  if (!s) return `OOB@(${Math.round(px)},${Math.round(py)})`;
  return `${c.id}=(${s.r},${s.g},${s.b}) d${c.dist.toFixed(0)}`;
}

function main() {
  const argv = process.argv.slice(2);
  const [webPath, nativePath, cellSizeArg, oxArg, oyArg, scaleArg] = argv;

  if (!webPath || !nativePath || cellSizeArg === undefined) {
    console.error(
      'Usage: node visual-compare.mjs <webPng> <nativePng> <cellSize> <originXpx> <originYpx> <scale>'
    );
    process.exit(2);
  }

  const cellSize = Number(cellSizeArg);
  const originX = Number(oxArg ?? 0);
  const originY = Number(oyArg ?? 0);
  const scale = Number(scaleArg ?? 1);

  if (!Number.isFinite(cellSize) || !Number.isFinite(originX) || !Number.isFinite(originY) || !Number.isFinite(scale)) {
    console.error('cellSize, originX, originY, scale must all be numbers.');
    process.exit(2);
  }

  const geo = computeHexGeometry(COLS, VISIBLE_ROWS, cellSize);
  const web = loadPng(webPath);
  const native = loadPng(nativePath);

  console.log(
    `Geometry  : hexSize=${geo.hexSize.toFixed(6)} hexH=${geo.hexH.toFixed(6)} ` +
      `colW=${geo.colW.toFixed(6)} board=${geo.boardWidth.toFixed(3)}x${geo.boardHeight.toFixed(3)}`
  );
  console.log(`Mapping   : cellSize=${cellSize} origin=(${originX},${originY}) scale=${scale}`);
  console.log(`Web PNG   : ${web.width}x${web.height}`);
  console.log(`Native PNG: ${native.width}x${native.height}`);
  console.log('');
  console.log('col row expect  web                       native                    result');
  console.log('-------------------------------------------------------------------------------');

  let pass = 0;
  let total = 0;

  for (let col = 0; col < BOTTOM_ROW.length; col++) {
    const typeId = BOTTOM_ROW[col];
    const row = BOTTOM_ROW_INDEX;

    // Board-local hex center (matches BoardRenderer._hexCenter with x=y=0).
    const bx = geo.colW * col + geo.hexSize;
    const by = geo.hexH * (row + 0.5 * (col & 1)) + geo.hexH / 2;

    const px = bx * scale + originX;
    const py = by * scale + originY;

    const ws = sample(web, px, py);
    const ns = sample(native, px, py);
    const wc = ws ? classify(ws.r, ws.g, ws.b) : null;
    const nc = ns ? classify(ns.r, ns.g, ns.b) : null;

    const webOk = !!wc && wc.id === typeId;
    const natOk = !!nc && nc.id === typeId;
    const ok = webOk && natOk;

    total++;
    if (ok) pass++;

    const tail = ok ? 'PASS' : `FAIL (web ${webOk ? 'ok' : 'BAD'}, native ${natOk ? 'ok' : 'BAD'})`;
    console.log(
      `${String(col).padEnd(3)} ${String(row).padEnd(3)} ${String(typeId).padEnd(7)} ` +
        `${fmtCell(px, py, ws, wc).padEnd(25)} ${fmtCell(px, py, ns, nc).padEnd(25)} ${tail}`
    );
  }

  const pct = total ? ((100 * pass) / total).toFixed(1) : '0.0';
  console.log('-------------------------------------------------------------------------------');
  console.log(`Overall: ${pass}/${total} cells parity-correct (${pct}%)`);

  process.exit(pass === total ? 0 : 1);
}

main();
