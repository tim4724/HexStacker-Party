// Generate SVG favicon (hex mode)
// Usage: node artwork/generate-favicon-svg.js

const fs = require('fs');
const path = require('path');

const GOLD = '#FFD700';

// --- Hex: T-piece with flat-top hexagons ---
function generateHexSVG() {
  // Flat-top hex: pointy sides on left/right, flat on top/bottom
  const R = 10; // outer radius
  const hexH = Math.sqrt(3) * R; // ~17.32

  // Generate hex polygon points centered at (0,0)
  const hexPoints = [];
  for (let i = 0; i < 6; i++) {
    const angle = Math.PI / 3 * i;
    hexPoints.push(`${(R * Math.cos(angle)).toFixed(2)},${(R * Math.sin(angle)).toFixed(2)}`);
  }
  const hexPointsStr = hexPoints.join(' ');

  // T-piece on flat-top odd-q hex grid
  // Col spacing = 1.5 * R, odd columns shift down by hexH/2
  const gap = 1.5;
  const colSpacing = 1.5 * R + gap;

  // Offset grid cells: [col, row]
  const gridCells = [[0,1], [1,0], [2,1], [1,-1]];

  const centers = gridCells.map(([col, row]) => {
    const cx = col * colSpacing;
    const rowH = hexH + gap;
    const cy = row * rowH + (col & 1 ? rowH / 2 : 0);
    return [cx, cy];
  });

  const allX = centers.flatMap(([cx]) => [cx - R, cx + R]);
  const allY = centers.flatMap(([, cy]) => [cy - hexH/2, cy + hexH/2]);
  const minX = Math.min(...allX);
  const minY = Math.min(...allY);
  const maxX = Math.max(...allX);
  const maxY = Math.max(...allY);

  const pad = 0.5;
  const vbX = minX - pad;
  const vbY = minY - pad;
  const vbW = maxX - minX + pad * 2;
  const vbH = maxY - minY + pad * 2;

  const hexes = centers.map(([cx, cy]) =>
    `  <polygon points="${hexPointsStr}" transform="translate(${cx.toFixed(2)},${cy.toFixed(2)})" fill="${GOLD}"/>`
  ).join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vbX.toFixed(2)} ${vbY.toFixed(2)} ${vbW.toFixed(2)} ${vbH.toFixed(2)}">\n${hexes}\n</svg>\n`;
}

const publicDir = path.resolve(__dirname, '..', 'public');

fs.writeFileSync(path.resolve(publicDir, 'favicon.svg'), generateHexSVG());

console.log('Generated: public/favicon.svg');
console.log('Run `magick` to regenerate favicon.ico from the SVG:');
console.log('  magick -background none -density 384 public/favicon.svg -resize "48x48>" -gravity center -extent 48x48 /tmp/favicon-48.png');
console.log('  (repeat for 16, 32, 64 and bundle: magick /tmp/favicon-*.png public/favicon.ico)');
