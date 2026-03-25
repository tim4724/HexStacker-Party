'use strict';

// -- Piece data (SRS rotation 0) --
var PIECES = {
  I: { id: 1, color: '#00F0F0', blocks: [[0,1],[1,1],[2,1],[3,1]] },
  J: { id: 2, color: '#0000F0', blocks: [[0,0],[0,1],[1,1],[2,1]] },
  L: { id: 3, color: '#F0A000', blocks: [[2,0],[0,1],[1,1],[2,1]] },
  O: { id: 4, color: '#F0F000', blocks: [[1,0],[2,0],[1,1],[2,1]] },
  S: { id: 5, color: '#00F000', blocks: [[1,0],[2,0],[0,1],[1,1]] },
  T: { id: 6, color: '#A000F0', blocks: [[1,0],[0,1],[1,1],[2,1]] },
  Z: { id: 7, color: '#F00000', blocks: [[0,0],[1,0],[1,1],[2,1]] },
};

var currentPieceKey = 'T';

// -- Helpers --
function hexToRgb(hex) {
  var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return m ? { r: parseInt(m[1],16), g: parseInt(m[2],16), b: parseInt(m[3],16) } : null;
}
function lighten(hex, pct) {
  var rgb = hexToRgb(hex); if (!rgb) return hex;
  var f = 1 + pct/100;
  return 'rgb('+Math.min(255,Math.round(rgb.r*f))+','+Math.min(255,Math.round(rgb.g*f))+','+Math.min(255,Math.round(rgb.b*f))+')';
}
function darken(hex, pct) {
  var rgb = hexToRgb(hex); if (!rgb) return hex;
  var f = 1 - pct/100;
  return 'rgb('+Math.round(rgb.r*f)+','+Math.round(rgb.g*f)+','+Math.round(rgb.b*f)+')';
}
function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w/2, h/2);
  ctx.beginPath();
  ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.quadraticCurveTo(x+w,y,x+w,y+r);
  ctx.lineTo(x+w,y+h-r); ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
  ctx.lineTo(x+r,y+h); ctx.quadraticCurveTo(x,y+h,x,y+h-r);
  ctx.lineTo(x,y+r); ctx.quadraticCurveTo(x,y,x+r,y);
  ctx.closePath();
}

// -- Board constants --
var COLS = 10, ROWS = 10;
var CELL = 26;
var PAD = 30;
var CW = COLS * CELL + PAD * 2;
var CH = ROWS * CELL + PAD * 2;
var BX = PAD, BY = PAD;

var RUBBLE = [
  [9,0,8],[9,1,8],[9,2,3],[9,3,8],[9,4,8],[9,5,8],[9,6,8],[9,7,2],[9,8,8],[9,9,8],
  [8,0,8],[8,1,5],[8,3,8],[8,5,8],[8,7,8],[8,8,8],[8,9,7],
  [7,0,1],[7,8,8],[7,9,4],
];
var RUBBLE_COLORS = { 1:'#00F0F0', 2:'#0000F0', 3:'#F0A000', 4:'#F0F000', 5:'#00F000', 7:'#F00000', 8:'#3a3a4e' };

// Landing row for the piece (where it locks)
var LAND_ROW = 5;
// Spawn row
var SPAWN_ROW = 0;
// Gravity: ms per row drop
var GRAVITY_MS = 300;
// How long locked piece stays before next cycle (ms)
var RESTART_DELAY = 1200;

function createEngine(ctx) {
  var anims = [];
  return {
    anims: anims,
    add: function(a) { a.startTime = performance.now(); anims.push(a); },
    update: function(ts) {
      for (var i = anims.length - 1; i >= 0; i--) {
        var a = anims[i];
        var p = Math.min((ts - a.startTime) / a.duration, 1);
        if (a.update) a.update(p);
        if (p >= 1) anims.splice(i, 1);
      }
    },
    render: function(ts) {
      for (var i = 0; i < anims.length; i++) {
        var a = anims[i];
        var p = Math.min((ts - a.startTime) / a.duration, 1);
        if (a.render) a.render(ctx, p);
      }
    }
  };
}

function drawBlock(ctx, col, row, color) {
  var x = BX + col * CELL, y = BY + row * CELL;
  var inset = CELL * 0.03, s = CELL - inset * 2, r = CELL * 0.12;
  var grad = ctx.createLinearGradient(0, 0, 0, CELL);
  grad.addColorStop(0, lighten(color, 15));
  grad.addColorStop(1, darken(color, 10));
  ctx.save(); ctx.translate(x, y);
  ctx.fillStyle = grad;
  roundRect(ctx, inset, inset, s, s, r); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  ctx.fillRect(inset + r, inset, s - r*2, CELL * 0.08);
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(inset + r, CELL - inset - CELL*0.08, s - r*2, CELL*0.08);
  ctx.restore();
}

function drawGhostBlock(ctx, col, row) {
  var x = BX + col * CELL, y = BY + row * CELL;
  var inset = CELL * 0.03, s = CELL - inset * 2, r = CELL * 0.12;
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1;
  roundRect(ctx, x + inset + 0.5, y + inset + 0.5, s - 1, s - 1, r);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  roundRect(ctx, x + inset, y + inset, s, s, r);
  ctx.fill();
}

function drawBoard(ctx) {
  ctx.fillStyle = '#080810';
  ctx.fillRect(BX, BY, COLS*CELL, ROWS*CELL);
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  for (var r = 1; r < ROWS; r++) { ctx.moveTo(BX, BY+r*CELL); ctx.lineTo(BX+COLS*CELL, BY+r*CELL); }
  for (var c = 1; c < COLS; c++) { ctx.moveTo(BX+c*CELL, BY); ctx.lineTo(BX+c*CELL, BY+ROWS*CELL); }
  ctx.stroke();
  for (var i = 0; i < RUBBLE.length; i++) {
    var rb = RUBBLE[i];
    drawBlock(ctx, rb[1], rb[0], RUBBLE_COLORS[rb[2]] || '#3a3a4e');
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.lineWidth = CELL * 0.04;
  var bw = ctx.lineWidth, half = bw/2;
  ctx.strokeRect(BX - half, BY - half, COLS*CELL + bw, ROWS*CELL + bw);
}

function getLockBlocks(piece, baseCol) {
  return piece.blocks.map(function(b) { return [b[0] + baseCol, b[1] + LAND_ROW]; });
}

function getBottomBlocks(blocks) {
  var bottom = {};
  for (var i = 0; i < blocks.length; i++) {
    var col = blocks[i][0], row = blocks[i][1];
    if (row < 0 || row >= 20) continue;
    if (bottom[col] == null || row > bottom[col]) bottom[col] = row;
  }
  return bottom;
}

// ==================================================================
// Shared sparkle
// ==================================================================
function addSparkle(engine, x, y, color, duration, vxMul, vyMul) {
  var vx = (Math.random() - 0.5) * (vxMul || 120);
  var vy = -(Math.random() * (vyMul || 80) + 20);
  var sz = CELL * (0.05 + Math.random() * 0.07);
  engine.add({
    duration: duration || 300,
    render: function(ctx, p) {
      var t = p * this.duration / 1000;
      var px = x + vx * t;
      var py = y + vy * t + 80 * t * t;
      ctx.save();
      ctx.globalAlpha = 1 - p;
      ctx.fillStyle = color;
      ctx.fillRect(px - sz/2, py - sz/2, sz * (1 - p*0.5), sz * (1 - p*0.5));
      ctx.restore();
    }
  });
}

// ==================================================================
// EDGE GLOW VARIATIONS
// ==================================================================

function varE1(engine, blocks, color) {
  var rgb = hexToRgb(color);
  engine.add({
    duration: 280,
    blocks: blocks,
    render: function(ctx, p) {
      var expand = p * CELL * 0.12;
      var a = 0.8 * (1 - p);
      var lw = CELL * 0.1 * (1 - p * 0.7);
      ctx.save();
      ctx.strokeStyle = 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + a + ')';
      ctx.lineWidth = lw;
      ctx.shadowColor = color;
      ctx.shadowBlur = CELL * 0.3 * (1 - p);
      for (var i = 0; i < this.blocks.length; i++) {
        var inset = CELL * 0.03;
        var bx = BX + this.blocks[i][0]*CELL + inset - expand;
        var by = BY + this.blocks[i][1]*CELL + inset - expand;
        var bs = CELL - inset*2 + expand*2;
        roundRect(ctx, bx, by, bs, bs, CELL * 0.12);
        ctx.stroke();
      }
      ctx.restore();
    }
  });
  var bottom = getBottomBlocks(blocks);
  for (var col in bottom) {
    for (var j = 0; j < 3; j++) {
      addSparkle(engine, BX+(parseInt(col)+Math.random())*CELL, BY+(bottom[col]+1)*CELL, color, 150+Math.random()*150, 80, 40);
    }
  }
}

function varE2(engine, blocks, color) {
  var rgb = hexToRgb(color);
  engine.add({
    duration: 200,
    blocks: blocks,
    render: function(ctx, p) {
      var expand = p * CELL * 0.06;
      var a = 0.45 * (1 - p);
      var lw = CELL * 0.07 * (1 - p * 0.7);
      ctx.save();
      ctx.strokeStyle = 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + a + ')';
      ctx.lineWidth = lw;
      ctx.shadowColor = color;
      ctx.shadowBlur = CELL * 0.15 * (1 - p);
      for (var i = 0; i < this.blocks.length; i++) {
        var inset = CELL * 0.03;
        var bx = BX + this.blocks[i][0]*CELL + inset - expand;
        var by = BY + this.blocks[i][1]*CELL + inset - expand;
        var bs = CELL - inset*2 + expand*2;
        roundRect(ctx, bx, by, bs, bs, CELL * 0.12);
        ctx.stroke();
      }
      ctx.restore();
    }
  });
  var bottom = getBottomBlocks(blocks);
  for (var col in bottom) {
    for (var j = 0; j < 2; j++) {
      addSparkle(engine, BX+(parseInt(col)+Math.random())*CELL, BY+(bottom[col]+1)*CELL, color, 120+Math.random()*120, 80, 40);
    }
  }
}

function varE3(engine, blocks, color) {
  var rgb = hexToRgb(color);
  engine.add({
    duration: 180,
    blocks: blocks,
    render: function(ctx, p) {
      var expand = p * CELL * 0.04;
      var a = 0.3 * (1 - p);
      var lw = CELL * 0.05 * (1 - p * 0.7);
      ctx.save();
      ctx.strokeStyle = 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + a + ')';
      ctx.lineWidth = lw;
      for (var i = 0; i < this.blocks.length; i++) {
        var inset = CELL * 0.03;
        var bx = BX + this.blocks[i][0]*CELL + inset - expand;
        var by = BY + this.blocks[i][1]*CELL + inset - expand;
        var bs = CELL - inset*2 + expand*2;
        roundRect(ctx, bx, by, bs, bs, CELL * 0.12);
        ctx.stroke();
      }
      ctx.restore();
    }
  });
  var bottom = getBottomBlocks(blocks);
  for (var col in bottom) {
    addSparkle(engine, BX+(parseInt(col)+Math.random())*CELL, BY+(bottom[col]+1)*CELL, color, 100+Math.random()*100, 50, 30);
  }
}

function varE4(engine, blocks, color) {
  var rgb = hexToRgb(color);
  engine.add({
    duration: 200,
    blocks: blocks,
    render: function(ctx, p) {
      var expand = p * CELL * 0.06;
      var a = 0.45 * (1 - p);
      var lw = CELL * 0.07 * (1 - p * 0.7);
      ctx.save();
      ctx.strokeStyle = 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + a + ')';
      ctx.lineWidth = lw;
      ctx.shadowColor = color;
      ctx.shadowBlur = CELL * 0.15 * (1 - p);
      for (var i = 0; i < this.blocks.length; i++) {
        var inset = CELL * 0.03;
        var bx = BX + this.blocks[i][0]*CELL + inset - expand;
        var by = BY + this.blocks[i][1]*CELL + inset - expand;
        var bs = CELL - inset*2 + expand*2;
        roundRect(ctx, bx, by, bs, bs, CELL * 0.12);
        ctx.stroke();
      }
      ctx.restore();
    }
  });
}

// ==================================================================
// DUST-ONLY VARIATIONS
// ==================================================================

function varD1(engine, blocks, color) {
  var bottom = getBottomBlocks(blocks);
  for (var col in bottom) {
    for (var j = 0; j < 2; j++) {
      addSparkle(engine, BX+(parseInt(col)+Math.random())*CELL, BY+(bottom[col]+1)*CELL, color, 120+Math.random()*120, 80, 40);
    }
  }
}

function varD2(engine, blocks, color) {
  var bottom = getBottomBlocks(blocks);
  for (var col in bottom) {
    var row = bottom[col];
    for (var j = 0; j < 3; j++) {
      var px = BX + (parseInt(col) + Math.random()) * CELL;
      var py = BY + (row + 1) * CELL;
      var vx = (Math.random() - 0.5) * 40;
      var sz = CELL * (0.04 + Math.random() * 0.04);
      (function(px, py, vx, sz) {
        engine.add({
          duration: 250 + Math.random() * 150,
          render: function(ctx, p) {
            var t = p * this.duration / 1000;
            var x = px + vx * t;
            var y = py + 8 * t * t;
            ctx.save();
            ctx.globalAlpha = 0.5 * (1 - p);
            ctx.fillStyle = 'rgba(255,255,255,0.8)';
            ctx.beginPath();
            ctx.arc(x, y, sz * (1 + p * 0.3), 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
          }
        });
      })(px, py, vx, sz);
    }
  }
}

function varD3(engine, blocks, color) {
  for (var i = 0; i < blocks.length; i++) {
    var col = blocks[i][0], row = blocks[i][1];
    if (row < 0 || row >= 20) continue;
    for (var j = 0; j < 3; j++) {
      addSparkle(engine, BX+(col+Math.random())*CELL, BY+(row+1)*CELL, color, 150+Math.random()*200, 120, 60);
    }
  }
}

function varD4(engine, blocks, color) {
  var bottom = getBottomBlocks(blocks);
  for (var col in bottom) {
    var row = bottom[col];
    var c = parseInt(col);
    addSparkle(engine, BX+(c+Math.random())*CELL, BY+(row+1)*CELL, color, 140+Math.random()*100, 60, 35);
    addSparkle(engine, BX+(c+Math.random())*CELL, BY+(row+1)*CELL, '#ffffff', 100+Math.random()*100, 50, 25);
  }
}

// ==================================================================
// PIECE STATE per instance
// Piece drops one row per gravity tick until it lands, then animation plays
// ==================================================================

function createFallingPiece(ts) {
  return {
    state: 'falling',     // 'falling' | 'locked'
    row: SPAWN_ROW,       // current integer row
    lastDropTime: ts || performance.now(),
    lockTime: 0,
    baseCol: 3
  };
}

function updateFallingPiece(fp, ts, deltaMs, engine, varFn) {
  var piece = PIECES[currentPieceKey];

  if (fp.state === 'falling') {
    // Drop one row per gravity tick
    if (ts - fp.lastDropTime >= GRAVITY_MS) {
      fp.lastDropTime = ts;
      if (fp.row < LAND_ROW) {
        fp.row++;
      }
      if (fp.row >= LAND_ROW) {
        fp.state = 'locked';
        fp.lockTime = ts;
        var blocks = getLockBlocks(piece, fp.baseCol);
        varFn(engine, blocks, piece.color);
      }
    }
  } else if (fp.state === 'locked') {
    if (ts - fp.lockTime >= RESTART_DELAY) {
      fp.state = 'falling';
      fp.row = SPAWN_ROW;
      fp.lastDropTime = ts;
    }
  }
}

// ==================================================================
// SETUP
// ==================================================================

var VARIATIONS = [
  { name: 'E1: Edge Glow (strong)', desc: 'Bold outline, large shadow, more particles.', fn: varE1 },
  { name: 'E2: Edge Glow (subtle)', desc: 'Current production. Softer glow, fewer particles.', fn: varE2 },
  { name: 'E3: Edge Glow (whisper)', desc: 'Very faint outline, no shadow blur, minimal dust.', fn: varE3 },
  { name: 'E4: Edge Glow (no dust)', desc: 'Glow outline only, zero particles.', fn: varE4 },
  { name: 'D1: Dust — colored sparks', desc: 'No glow. Small colored sparks at bottom edges.', fn: varD1 },
  { name: 'D2: Dust — white puffs', desc: 'No glow. Round white particles, slow drift.', fn: varD2 },
  { name: 'D3: Dust — lively colored', desc: 'No glow. More particles, faster, wider spread.', fn: varD3 },
  { name: 'D4: Dust — mixed gentle', desc: 'No glow. Colored + white spark per column.', fn: varD4 },
];

var instances = [];

function buildPieceSelector() {
  var el = document.getElementById('piece-selector');
  var keys = Object.keys(PIECES);
  for (var i = 0; i < keys.length; i++) {
    (function(key) {
      var btn = document.createElement('button');
      btn.className = 'piece-btn' + (key === currentPieceKey ? ' active' : '');
      btn.style.background = PIECES[key].color;
      btn.textContent = key;
      btn.addEventListener('click', function() {
        currentPieceKey = key;
        document.querySelectorAll('.piece-btn').forEach(function(b) { b.classList.remove('active'); });
        btn.classList.add('active');
        var now = performance.now();
        for (var k = 0; k < instances.length; k++) {
          instances[k].fp = createFallingPiece(now);
          instances[k].engine.anims.length = 0;
        }
      });
      el.appendChild(btn);
    })(keys[i]);
  }
}

function buildCards() {
  var gridEl = document.getElementById('grid');
  for (var i = 0; i < VARIATIONS.length; i++) {
    var v = VARIATIONS[i];
    var card = document.createElement('div');
    card.className = 'card';
    var h2 = document.createElement('h2');
    h2.textContent = v.name;
    var desc = document.createElement('div');
    desc.className = 'desc';
    desc.textContent = v.desc;
    var canvas = document.createElement('canvas');
    var dpr = window.devicePixelRatio || 1;
    canvas.width = CW * dpr;
    canvas.height = CH * dpr;
    canvas.style.width = CW + 'px';
    canvas.style.height = CH + 'px';
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'Click to hard drop';

    card.appendChild(h2);
    card.appendChild(desc);
    card.appendChild(canvas);
    card.appendChild(hint);
    gridEl.appendChild(card);

    var engine = createEngine(ctx);
    var inst = { ctx: ctx, canvas: canvas, engine: engine, varFn: v.fn, fp: createFallingPiece(performance.now()) };
    instances.push(inst);

    // Click to hard-drop instantly
    (function(inst) {
      canvas.addEventListener('click', function() {
        if (inst.fp.state === 'falling') {
          inst.fp.row = LAND_ROW;
          inst.fp.state = 'locked';
          inst.fp.lockTime = performance.now();
          var piece = PIECES[currentPieceKey];
          var blocks = getLockBlocks(piece, inst.fp.baseCol);
          inst.varFn(inst.engine, blocks, piece.color);
        }
      });
    })(inst);
  }
}

var lastTs = 0;

function renderAll(ts) {
  requestAnimationFrame(renderAll);
  var deltaMs = lastTs ? Math.min(ts - lastTs, 50) : 0;
  lastTs = ts;

  var piece = PIECES[currentPieceKey];

  for (var i = 0; i < instances.length; i++) {
    var inst = instances[i];
    var ctx = inst.ctx;
    var fp = inst.fp;

    // Update falling piece
    updateFallingPiece(fp, ts, deltaMs, inst.engine, inst.varFn);

    // Clear & draw board
    ctx.clearRect(0, 0, CW, CH);
    ctx.fillStyle = '#06060f';
    ctx.fillRect(0, 0, CW, CH);
    drawBoard(ctx);

    if (fp.state === 'locked') {
      // Draw piece at landing position
      var lockBlocks = getLockBlocks(piece, fp.baseCol);
      for (var b = 0; b < lockBlocks.length; b++) {
        drawBlock(ctx, lockBlocks[b][0], lockBlocks[b][1], piece.color);
      }
    } else {
      // Falling: show ghost at landing + piece at current row
      var ghostBlocks = getLockBlocks(piece, fp.baseCol);
      for (var g = 0; g < ghostBlocks.length; g++) {
        drawGhostBlock(ctx, ghostBlocks[g][0], ghostBlocks[g][1]);
      }
      for (var f = 0; f < piece.blocks.length; f++) {
        drawBlock(ctx, piece.blocks[f][0] + fp.baseCol, piece.blocks[f][1] + fp.row, piece.color);
      }
    }

    // Animations
    inst.engine.update(ts);
    inst.engine.render(ts);
  }
}

buildPieceSelector();
buildCards();
document.getElementById('replay-all-btn').addEventListener('click', function() {
  var now = performance.now();
  for (var i = 0; i < instances.length; i++) {
    instances[i].fp = createFallingPiece(now);
    instances[i].engine.anims.length = 0;
  }
});
requestAnimationFrame(renderAll);
