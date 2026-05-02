// Clip F — Winner + CTA (~2.0s).
// No results screen: the chaos8p clip dissolves directly into the title
// card on a clean dark background. (Showing a 4-player results table after
// an 8-player chaos clip felt wrong — the player counts didn't match.)

export async function stage({ titleCard }) {
  await renderQR(titleCard);
}

export async function run({ titleCard }) {
  // Hide the display iframe entirely so only the title card + dark
  // backdrop remain. The composite background already provides the
  // brand-tinted gradient.
  const frame = document.getElementById('display-frame');
  if (frame) frame.style.opacity = '0';
  setTimeout(() => titleCard.classList.add('in'), 100);
  titleCard.classList.remove('hidden');
  await wait(2400);
}

async function renderQR(titleCard) {
  const canvas = titleCard.querySelector('#title-qr');
  if (!canvas) return;
  try {
    const res = await fetch('/api/qr?text=' + encodeURIComponent('https://hexstacker.com'));
    const matrix = await res.json();
    drawMatrix(canvas, matrix);
  } catch (err) {
    console.warn('[adclip/winner] QR fetch failed:', err);
  }
}

// Mirrors the lobby's renderQR (public/display/DisplayUI.js) — rounded plum
// cells on a white card, with a small inset between cells. Keeping the QR
// look consistent across lobby and CTA screens.
function drawMatrix(canvas, matrix) {
  const size = matrix.size;
  const cellPx = 10;
  const totalPx = size * cellPx;
  canvas.width = totalPx;
  canvas.height = totalPx;

  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, totalPx, totalPx);

  const inset = Math.max(0.5, cellPx * 0.03);
  const radius = Math.max(1, cellPx * 0.15);
  ctx.fillStyle = '#2A2540';

  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (!matrix.modules[row * size + col]) continue;
      const x = col * cellPx + inset;
      const y = row * cellPx + inset;
      const s = cellPx - inset * 2;
      roundedRect(ctx, x, y, s, s, radius);
      ctx.fill();
    }
  }
}

function roundedRect(ctx, x, y, w, h, r) {
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

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
