'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PARTY_PALETTE, PLAYER_COLORS } = require('../public/shared/theme.js');

const ROOT = path.resolve(__dirname, '..');
const THEME_CSS = fs.readFileSync(path.join(ROOT, 'public/shared/theme.css'), 'utf8');
const BUILDER_HTML = fs.readFileSync(path.join(ROOT, 'artwork/builder.html'), 'utf8');

function hexToRgbTuple(hex) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`bad hex: ${hex}`);
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)].join(', ');
}

function readVar(css, name) {
  const m = new RegExp(`${name}:\\s*([^;]+);`).exec(css);
  return m ? m[1].trim() : null;
}

describe('palette consistency — JS, CSS, and canvas agree', function () {
  it('theme.css --accent-primary-rgb matches PARTY_PALETTE[0] (Red)', function () {
    assert.equal(readVar(THEME_CSS, '--accent-primary-rgb'), hexToRgbTuple(PARTY_PALETTE[0]));
  });

  it('theme.css --accent-secondary-rgb matches PARTY_PALETTE[7] (Tangerine)', function () {
    assert.equal(readVar(THEME_CSS, '--accent-secondary-rgb'), hexToRgbTuple(PARTY_PALETTE[7]));
  });

  it('brand-mark.svg triad cells are drawn from PARTY_PALETTE (teal, red, honey)', function () {
    const svg = fs.readFileSync(path.join(ROOT, 'public/shared/brand-mark.svg'), 'utf8');
    const fills = [...svg.matchAll(/fill="(#[0-9a-fA-F]{6})"/g)].map(m => m[1].toUpperCase());
    assert.deepEqual(
      fills,
      [PARTY_PALETTE[1], PARTY_PALETTE[0], PARTY_PALETTE[2]].map(c => c.toUpperCase()),
      'brand-mark cells must be palette teal, red, honey in draw order'
    );
  });

  it('artwork/builder.html titleGradient() stops match PLAYER_COLORS spectrum order', function () {
    const m = /function titleGradient\([\s\S]*?return g;\s*\}/.exec(BUILDER_HTML);
    assert.ok(m, 'titleGradient() not found in builder.html');
    const stops = m[0].match(/#[0-9a-fA-F]{6}/g) || [];
    assert.deepEqual(
      stops.map(s => s.toUpperCase()),
      PLAYER_COLORS.map(c => c.toUpperCase()),
      'Canvas gradient stops must equal PLAYER_COLORS in order'
    );
  });
});
