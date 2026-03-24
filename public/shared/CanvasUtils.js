'use strict';

// ============================================================
// Shared Canvas Utilities — used by BoardRenderer, UIRenderer,
// and display.js for common drawing operations
// ============================================================

function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : null;
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

var _lightenCache = new Map();
function lightenColor(hex, percent) {
  const key = hex + '_' + percent;
  let cached = _lightenCache.get(key);
  if (cached !== undefined) return cached;
  const rgb = hexToRgb(hex);
  if (!rgb) { _lightenCache.set(key, hex); return hex; }
  const factor = 1 + percent / 100;
  const r = Math.min(255, Math.round(rgb.r * factor));
  const g = Math.min(255, Math.round(rgb.g * factor));
  const b = Math.min(255, Math.round(rgb.b * factor));
  cached = `rgb(${r}, ${g}, ${b})`;
  _lightenCache.set(key, cached);
  return cached;
}

function darkenColor(hex, percent) {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const factor = 1 - percent / 100;
  const r = Math.round(rgb.r * factor);
  const g = Math.round(rgb.g * factor);
  const b = Math.round(rgb.b * factor);
  return `rgb(${r}, ${g}, ${b})`;
}

// Compute a ghost-piece color from any hex piece color.
// Lightens dark channels for visibility on dark backgrounds, with alpha
// scaled by luminance (darker pieces get higher alpha).
// Returns an rgba() string. Used for ghost rendering in all style tiers.
function ghostColor(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return 'rgba(255,255,255,0.3)';
  // Blend 30% toward white, with a floor of 80 per channel
  const r = Math.min(255, Math.max(80, Math.round(rgb.r + (255 - rgb.r) * 0.3)));
  const g = Math.min(255, Math.max(80, Math.round(rgb.g + (255 - rgb.g) * 0.3)));
  const b = Math.min(255, Math.max(80, Math.round(rgb.b + (255 - rgb.b) * 0.3)));
  // Darker colors need higher alpha to stay visible
  const lum = (rgb.r * 0.299 + rgb.g * 0.587 + rgb.b * 0.114) / 255;
  const a = (0.3 + (1 - lum) * 0.15).toFixed(2);
  return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
}

// Shared font detection — returns the preferred display font family string.
// Checks whether Orbitron has loaded; falls back to monospace.
// Re-checks on each font load event until Orbitron is detected.
var _fontLoaded = false;
if (typeof document !== 'undefined' && document.fonts && document.fonts.addEventListener) {
  document.fonts.addEventListener('loadingdone', function() {
    if (!_fontLoaded) {
      _fontLoaded = document.fonts?.check?.('700 12px Orbitron') ?? false;
    }
  });
}
function getDisplayFont() {
  if (!_fontLoaded) {
    _fontLoaded = document.fonts?.check?.('700 12px Orbitron') ?? false;
  }
  return _fontLoaded ? 'Orbitron' : '"Courier New", monospace';
}
