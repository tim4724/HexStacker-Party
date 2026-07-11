'use strict';

// ============================================================
// Design Tokens — single source of truth for the visual layer
// ============================================================

// --- Party Palette — 8 slots, single source of truth for pieces, players,
// and UI accents. Garbage (#808080) is intentionally off-palette to keep
// its "not yours / threatening" read.
// Slots 1/2/3 (red/teal/honey) also color the brand-mark triad
// (shared/brand-mark.svg); the artwork generators (artwork/builder.html)
// still mirror the full 8-slot spectrum. If you tweak a slot, sync both.
const PARTY_PALETTE = Object.freeze([
  '#FF6B6B', // 1 Red        ← UI accent (primary)
  '#4ECDC4', // 2 Teal
  '#FFE066', // 3 Honey      ← UI accent (tertiary)
  '#A78BFA', // 4 Violet
  '#7BED6F', // 5 Mint
  '#F178D8', // 6 Magenta
  '#5B7FFF', // 7 Indigo
  '#FF8C42'  // 8 Tangerine  ← UI accent (secondary)
]);

// --- Piece colors (1=I3, 2=V3, 3=T3, 4=o, 5=d, 6=b, 9=garbage) ---
// The 6-piece casual bag uses palette slots 0-5; slots 6 (Indigo) and 7
// (Tangerine) are unused and available for future pieces or accents.
// The near-clear pulse uses white (extending the "white = clear-related"
// vocabulary of the clear preview and clear glow).
const PIECE_COLORS = {
  0: '#000000',             // empty
  1: PARTY_PALETTE[0],      // I3 - red
  2: PARTY_PALETTE[1],      // V3 - teal
  3: PARTY_PALETTE[2],      // T3 - honey
  4: PARTY_PALETTE[3],      // o  - violet
  5: PARTY_PALETTE[4],      // d  - mint
  6: PARTY_PALETTE[5],      // b  - magenta
  9: '#808080'              // garbage - neutral gray (intentionally off-palette)
};

// Ghost piece colors — computed from PIECE_COLORS via ghostColor() (CanvasUtils.js).
// Silently skipped when CanvasUtils.js isn't loaded: the controller doesn't
// render ghost pieces so it intentionally omits CanvasUtils. If a display
// renderer that needs GHOST_COLORS runs without CanvasUtils loaded, it will
// crash on its own — much more obvious than a startup warning.
var GHOST_COLORS = {};
if (typeof ghostColor === 'function') {
  for (var _i = 1; _i <= 9; _i++) {
    if (PIECE_COLORS[_i]) GHOST_COLORS[_i] = ghostColor(PIECE_COLORS[_i]);
  }
}

// Player accent colors — reordered from PARTY_PALETTE to follow the visible
// spectrum across player slots: red, tangerine, honey, mint, teal, indigo, violet, magenta.
const PLAYER_COLORS = Object.freeze([
  PARTY_PALETTE[0], // Red
  PARTY_PALETTE[7], // Tangerine
  PARTY_PALETTE[2], // Honey
  PARTY_PALETTE[4], // Mint
  PARTY_PALETTE[1], // Teal
  PARTY_PALETTE[6], // Indigo
  PARTY_PALETTE[3], // Violet
  PARTY_PALETTE[5], // Magenta
]);

const PLAYER_NAMES = ['Player 1', 'Player 2', 'Player 3', 'Player 4', 'Player 5', 'Player 6', 'Player 7', 'Player 8'];

// Level-based style tiers
const STYLE_TIERS = Object.freeze({
  NORMAL: 'normal',         // Lv 1–5
  PILLOW: 'pillow',         // Lv 6–10
  NEON_FLAT: 'neonFlat'     // Lv 11+
});

function getStyleTier(level) {
  if (level >= 11) return STYLE_TIERS.NEON_FLAT;
  if (level >= 6)  return STYLE_TIERS.PILLOW;
  return STYLE_TIERS.NORMAL;
}

// --- Theme tokens ---
const THEME = Object.freeze({

  // ---- Colors ----
  color: Object.freeze({
    bg: Object.freeze({
      primary:   '#1E1A2B',    // Cocoa plum-dark
      board:     '#15121F',    // deeper plum for board canvas
      secondary: '#181421',
      card:      '#2A2540',    // Cocoa surface
      cardSoft:  '#342E4D',
    }),
    text: Object.freeze({
      primary:   '#F7F1E8',    // warm cream
      secondary: 'rgba(247, 241, 232, 0.65)',
      white:     '#ffffff',
    }),
    accent: Object.freeze({
      primary:      '#FF6B6B', // palette slot 1 Red — UI primary
      primaryDark:  '#E55A5A',
      secondary:    '#FF8C42', // palette slot 8 Tangerine — UI secondary
      secondaryDark:'#E67A33',
    }),
    danger:  '#ff4444',
    // Warm-paper hairline for socket rims and ring strokes — mirrors the
    // rgba(255,248,236,X) --border family in theme.css.
    hairline: '#FFF8EC',
    nearClear: '#F7F1E8',     // Cream outline pulse — extends the "cream = clear-related" vocabulary shared with the clear preview (cream fill) and clear glow. Outline-only + animated keeps it distinct from the static preview.
    ko: Object.freeze({
      text: '#ff4444',
      glow: 'rgba(255, 50, 50, 0.6)',
    }),
    btn: Object.freeze({
      primaryText: '#1E1A2B',  // mirrors --btn-primary-text in theme.css
    }),
    // Animation-specific named colors (palette-aligned). Triple is the top
    // celebration tier with the casual bag (quad is unreachable, see Piece.js).
    triple:  '#FFE066',        // palette slot 3 Honey
  }),

  // ---- Opacities ----
  opacity: Object.freeze({
    faint:     0.04,  // noise textures, barely-there tints
    tint:      0.06,  // player color surface tints
    boardTint: 0.12,  // board-card player tint (bolder than generic tint)
    subtle:    0.08,  // ghost fills, inner shines, scanlines
    muted:     0.10,  // dot patterns
    grid:      0.18,  // grid lines
    soft:      0.15,  // borders, soft accents
    hairline:  0.12,  // socket-rim hairline strokes (× color.hairline)
    highlight: 0.16,  // block top highlight
    shadow:    0.25,  // block bottom shadow
    label:     0.6,   // panel labels, toolbar text
    wall:      0.5,   // board wall stroke (player color)
    overlay:   0.75,  // dark overlays
    panel:     0.9,   // card/panel backgrounds
  }),

  // ---- Border Radii (functions of cell/block size) ----
  radius: Object.freeze({
    block: (size) => size * 0.12,
    panel: (size) => size * 0.2,
  }),

  // ---- Stroke Widths (× cellSize) ----
  stroke: Object.freeze({
    grid:   0.03,
    border: 0.04,
    ghost:  0.05,
  }),

  // ---- Animation Timing (ms) ----
  timing: Object.freeze({
    lineClear:    600,
    garbageShake: 180,
    textPopup:    1200,
    ko:           1800,
  }),

  // ---- Font Size Multipliers (× cellSize) with minimum px floors ----
  font: Object.freeze({
    cellScale: Object.freeze({
      name:  0.9,
      label: 0.48,
      mini:  0.6,
    }),
    minPx: Object.freeze({
      name:  24,
      label: 14,
    }),
  }),

  // ---- Sizing Constants ----
  size: Object.freeze({
    panelWidth:  4.5,   // cellSize multiplier for panel width
    panelGap:    0.25,  // panel-to-board gap (× cellSize)
    canvasPad:   5,     // canvas edge padding px
    blockGap:    0.03,  // half-gap between blocks (× cellSize)
  }),
});

// Hex → "rgba(r, g, b, a)" string. Used by call sites that set CSS
// variables to player-colored values where color-mix() cannot be
// used (old browsers reject invalid custom-property substitutions).
function rgbaFromHex(hex, alpha) {
  var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
  if (!m) return 'transparent';
  return 'rgba(' + parseInt(m[1], 16) + ', ' + parseInt(m[2], 16) + ', ' + parseInt(m[3], 16) + ', ' + alpha + ')';
}

// Export for both Node.js and browser
if (typeof module !== 'undefined' && module.exports) {
  // IMPORTANT: _gc must mirror ghostColor() in CanvasUtils.js — keep in sync!
  var _gc = function(hex) {
    var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!m) return { outline: 'rgba(255,255,255,0.3)', fill: 'rgba(255,255,255,0.15)' };
    var rv = parseInt(m[1],16), gv = parseInt(m[2],16), bv = parseInt(m[3],16);
    var r = Math.min(255, Math.max(80, Math.round(rv + (255-rv)*0.3)));
    var g = Math.min(255, Math.max(80, Math.round(gv + (255-gv)*0.3)));
    var b = Math.min(255, Math.max(80, Math.round(bv + (255-bv)*0.3)));
    var lum = (rv*0.299 + gv*0.587 + bv*0.114) / 255;
    var a = +(0.3 + (1-lum)*0.15).toFixed(2);
    var fillA = +(a * 0.5).toFixed(2);
    return {
      outline: 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')',
      fill: 'rgba(' + r + ',' + g + ',' + b + ',' + fillA + ')'
    };
  };
  for (var _k = 1; _k <= 9; _k++) {
    if (PIECE_COLORS[_k] && !GHOST_COLORS[_k]) GHOST_COLORS[_k] = _gc(PIECE_COLORS[_k]);
  }
  module.exports = {
    THEME,
    PARTY_PALETTE,
    PIECE_COLORS, GHOST_COLORS,
    STYLE_TIERS, getStyleTier, PLAYER_COLORS, PLAYER_NAMES,
    rgbaFromHex
  };
}
