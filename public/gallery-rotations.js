'use strict';

// Rotation debug: for each piece, render 6 consecutive CW rotations on a small
// hex grid. The visualization mirrors PlayerBoard._tryRotate: rotateCW() →
// _adjustAnchorRow(), no wall kicks. anchorCol is held at the grid center so
// any change in anchorRow is the on-board drift you'd actually see.

(function() {
  var Piece = PieceModule.Piece;
  var PIECES = PieceModule.PIECES;
  var PIECE_ROTATIONS = PieceModule.PIECE_ROTATIONS;
  var offsetToAxial = PieceModule.offsetToAxial;
  var axialToOffset = PieceModule.axialToOffset;
  var PIECE_TYPES = GameConstants.PIECE_TYPES;
  var PIECE_TYPE_TO_ID = GameConstants.PIECE_TYPE_TO_ID;

  // Local mini-grid sized to fit a 4-cell piece in any rotation with a 1-cell
  // border of context around the anchor. Pieces span at most ±1 cell from the
  // anchor in axial coords, which in offset is roughly ±1 col / ±2 row.
  // Anchor sits at the grid's center so _adjustAnchorRow never has to push the
  // piece downward — what you see is the pure cell transform.
  var GRID_COLS = 5;
  var GRID_ROWS = 5;
  var ANCHOR_COL = 2;              // center column (even → "high" parity)
  var ANCHOR_ROW = 2;              // center row — leaves ±2 offset rows of slack
  var CELL_SIZE = 36;              // baseline; canvas is drawn at 2x for retina
  var DPR = Math.min(window.devicePixelRatio || 1, 2);

  var geo = GameConstants.computeHexGeometry(GRID_COLS, GRID_ROWS, CELL_SIZE);

  function hexCenter(col, row) {
    return {
      x: geo.colW * col + geo.hexSize,
      y: geo.hexH * (row + 0.5 * (col & 1)) + geo.hexH / 2
    };
  }

  function tracePath(ctx, cx, cy, size) {
    ctx.beginPath();
    for (var i = 0; i < 6; i++) {
      var a = Math.PI / 3 * i;
      var x = cx + size * Math.cos(a);
      var y = cy + size * Math.sin(a);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  function makeCanvas() {
    var canvas = document.createElement('canvas');
    var pad = 4;
    var cssW = geo.boardWidth + pad * 2;
    var cssH = geo.boardHeight + pad * 2;
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    canvas.width = Math.ceil(cssW * DPR);
    canvas.height = Math.ceil(cssH * DPR);
    var ctx = canvas.getContext('2d');
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.translate(pad, pad);
    return { canvas: canvas, ctx: ctx };
  }

  function renderPiece(piece, color) {
    var made = makeCanvas();
    var ctx = made.ctx;

    // Faint background hex grid for spatial context.
    ctx.strokeStyle = 'rgba(247, 241, 232, 0.10)';
    ctx.lineWidth = 1;
    for (var c = 0; c < GRID_COLS; c++) {
      for (var r = 0; r < GRID_ROWS; r++) {
        var pos = hexCenter(c, r);
        tracePath(ctx, pos.x, pos.y, geo.hexSize - 1.5);
        ctx.stroke();
      }
    }

    // Mark the visual center column with a column highlight so vertical drift
    // reads at a glance.
    var centerTop = hexCenter(ANCHOR_COL, 0);
    var centerBottom = hexCenter(ANCHOR_COL, GRID_ROWS - 1);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(centerTop.x, 0);
    ctx.lineTo(centerBottom.x, geo.boardHeight);
    ctx.stroke();

    // Piece blocks.
    var blocks = piece.getAbsoluteBlocks();
    ctx.fillStyle = color;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.lineWidth = 1.2;
    for (var bi = 0; bi < blocks.length; bi++) {
      var col = blocks[bi][0], row = blocks[bi][1];
      if (col < 0 || col >= GRID_COLS || row < 0 || row >= GRID_ROWS) continue;
      var bp = hexCenter(col, row);
      tracePath(ctx, bp.x, bp.y, geo.hexSize - 2.5);
      ctx.fill();
      ctx.stroke();
    }

    // Anchor cell dot (white filled circle on the anchor block).
    if (piece.anchorCol >= 0 && piece.anchorCol < GRID_COLS &&
        piece.anchorRow >= 0 && piece.anchorRow < GRID_ROWS) {
      var ap = hexCenter(piece.anchorCol, piece.anchorRow);
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(ap.x, ap.y, 3.2, 0, Math.PI * 2);
      ctx.fill();
    }

    // cells[0] marker (white ring) — this is the "rotation-keyed" cell that
    // must be a non-anchor cell per Piece.js, since cells[0] (q,r) doubles as
    // the ghost-cache rotation key.
    var ax = offsetToAxial(piece.anchorCol, piece.anchorRow);
    var c0 = piece.cells[0];
    var c0o = axialToOffset(ax.q + c0.q, ax.r + c0.r);
    if (c0o.col >= 0 && c0o.col < GRID_COLS && c0o.row >= 0 && c0o.row < GRID_ROWS) {
      var p0 = hexCenter(c0o.col, c0o.row);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(p0.x, p0.y, geo.hexSize * 0.28, 0, Math.PI * 2);
      ctx.stroke();
    }

    return made.canvas;
  }

  function fmtCells(cells) {
    var parts = [];
    for (var i = 0; i < cells.length; i++) {
      parts.push('(' + cells[i].q + ',' + cells[i].r + ')');
    }
    return parts.join(' ');
  }

  // Raw axial CW rotation, applied directly to a cells array. Used by the
  // "all 6 rotations" view to bypass piece.rotateCW(), which now cycles
  // through the engine's dedup'd rotation table instead of stepping through
  // all six raw orientations.
  function rawRotateCellsCW(cells) {
    for (var i = 0; i < cells.length; i++) {
      var q = cells[i].q, r = cells[i].r;
      cells[i].q = -r;
      cells[i].r = q + r;
    }
  }

  function cellsKey(cells) {
    // Order-independent shape signature: sort axial cells and join. Lets us
    // flag rotations that produce an identical block-set to a prior rotation
    // (so the user can see at a glance which pieces have rotational symmetry).
    var sorted = cells.slice().sort(function(a, b) {
      return (a.q - b.q) || (a.r - b.r);
    });
    return sorted.map(function(c) { return c.q + ',' + c.r; }).join('|');
  }

  // Shared rendering scaffold: builds a piece object pinned to the centered
  // anchor, then renders one card per orientation in `orientations`. Each
  // orientation supplies its own cells, label, and meta builder.
  function renderOrientationGrid(piece, color, orientations) {
    var grid = document.createElement('div');
    grid.className = 'rot-grid';
    for (var oi = 0; oi < orientations.length; oi++) {
      var o = orientations[oi];
      // Mutate the piece's cells in place to match this orientation, then
      // hand off to renderPiece (which reads piece.cells/anchorCol/anchorRow).
      for (var ci = 0; ci < o.cells.length; ci++) {
        piece.cells[ci].q = o.cells[ci].q;
        piece.cells[ci].r = o.cells[ci].r;
      }
      var card = document.createElement('div');
      card.className = 'rot-card' + (o.cardClass ? ' ' + o.cardClass : '');
      var ch = document.createElement('div');
      ch.className = 'rot-card-head';
      var lab = document.createElement('span');
      lab.className = 'label';
      lab.textContent = o.label;
      ch.appendChild(lab);
      if (o.suffix) {
        var sf = document.createElement('span');
        sf.className = 'delta ' + (o.suffixState || 'zero');
        sf.textContent = o.suffix;
        ch.appendChild(sf);
      }
      card.appendChild(ch);
      card.appendChild(renderPiece(piece, color));
      if (o.meta) {
        var meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = o.meta;
        card.appendChild(meta);
      }
      if (o.tag) {
        var dt = document.createElement('div');
        dt.className = 'dup-tag';
        dt.textContent = o.tag;
        card.appendChild(dt);
      }
      grid.appendChild(card);
    }
    return grid;
  }

  function metaText(piece, cells) {
    // Re-sync piece.cells from `cells` so getAbsoluteBlocks reads the right
    // orientation; the caller has already mutated piece.cells, but the
    // explicit parameter makes the dependency clear.
    var blocks = piece.getAbsoluteBlocks();
    var blocksStr = blocks.map(function(b) { return '(' + b[0] + ',' + b[1] + ')'; }).join(' ');
    return 'anchor (' + piece.anchorCol + ',' + piece.anchorRow + ')\n'
      + 'cells:  ' + fmtCells(cells) + '\n'
      + 'blocks: ' + blocksStr;
  }

  function buildPieceSection(type) {
    var section = document.createElement('div');
    section.className = 'rot-piece';

    var typeId = PIECE_TYPE_TO_ID[type];
    var color = PIECE_COLORS[typeId];

    var head = document.createElement('div');
    head.className = 'rot-piece-head';
    var name = document.createElement('span');
    name.className = 'name';
    name.textContent = type;
    name.style.color = color;
    head.appendChild(name);
    var typeIdEl = document.createElement('span');
    typeIdEl.className = 'type-id';
    typeIdEl.textContent = 'typeId=' + typeId;
    head.appendChild(typeIdEl);
    var seed = document.createElement('span');
    seed.className = 'seed';
    seed.textContent = 'cycleLength = ' + PIECE_ROTATIONS[type].length
      + '  ·  anchor = (' + ANCHOR_COL + ',' + ANCHOR_ROW + ')';
    head.appendChild(seed);
    section.appendChild(head);

    // Anchor pinned to grid center, ±2 rows of slack so _adjustAnchorRow's
    // downward clamp never fires — what's left is the cell-level transform.
    var piece = new Piece(type);
    piece.anchorCol = ANCHOR_COL;
    piece.anchorRow = ANCHOR_ROW;

    // ---- View 1: raw 6 axial rotations (bypass the cycle) ----
    var rawHead = document.createElement('div');
    rawHead.className = 'sub-head';
    rawHead.textContent = 'Raw 60° rotations · all 6 axial steps';
    section.appendChild(rawHead);

    var rawCells = PIECES[type].map(function(c) { return { q: c[0], r: c[1] }; });
    var rawShapeFirstSeen = {};
    var rawOrientations = [];
    for (var r = 0; r < 6; r++) {
      var key = cellsKey(rawCells);
      var dupOf = rawShapeFirstSeen[key];
      if (dupOf === undefined) rawShapeFirstSeen[key] = r;
      rawOrientations.push({
        label: 'rot ' + r,
        cells: rawCells.map(function(c) { return { q: c.q, r: c.r }; }),
        meta: null,   // filled after we re-mount each rotation
        cardClass: dupOf !== undefined ? 'duplicate' : '',
        tag: dupOf !== undefined ? '↻ same shape as rot ' + dupOf : null
      });
      rawRotateCellsCW(rawCells);
    }
    // Build meta with absolute blocks (now that piece.cells will be set per orientation).
    for (var ri = 0; ri < rawOrientations.length; ri++) {
      var ro = rawOrientations[ri];
      // Temporarily set piece.cells to this orientation to compute blocks.
      for (var rj = 0; rj < ro.cells.length; rj++) {
        piece.cells[rj].q = ro.cells[rj].q;
        piece.cells[rj].r = ro.cells[rj].r;
      }
      ro.meta = metaText(piece, ro.cells);
    }
    section.appendChild(renderOrientationGrid(piece, color, rawOrientations));

    // ---- View 2: engine cycle (dedup'd + centroid-matched) ----
    var cycleHead = document.createElement('div');
    cycleHead.className = 'sub-head accent';
    var cycle = PIECE_ROTATIONS[type];
    cycleHead.textContent = 'Engine cycle · ' + cycle.length
      + (cycle.length === 1 ? ' state' : ' states')
      + ' — what rotateCW() actually steps through';
    section.appendChild(cycleHead);

    // Map each cycle entry back to its raw-rotation index for cross-reference.
    var cycleOrientations = [];
    for (var ci = 0; ci < cycle.length; ci++) {
      var entry = cycle[ci];
      var entryKey = entry.map(function(c) { return c.q + ',' + c.r; }).sort().join('|');
      // Find which raw rot index produced this cells set.
      var rawIdx = ci;
      var probeCells = PIECES[type].map(function(c) { return { q: c[0], r: c[1] }; });
      for (var probe = 0; probe < 6; probe++) {
        var probeKey = probeCells.map(function(c) { return c.q + ',' + c.r; }).sort().join('|');
        if (probeKey === entryKey) { rawIdx = probe; break; }
        rawRotateCellsCW(probeCells);
      }
      for (var ej = 0; ej < entry.length; ej++) {
        piece.cells[ej].q = entry[ej].q;
        piece.cells[ej].r = entry[ej].r;
      }
      cycleOrientations.push({
        label: 'step ' + ci,
        cells: entry.map(function(c) { return { q: c.q, r: c.r }; }),
        meta: metaText(piece, entry),
        suffix: 'raw rot ' + rawIdx,
        suffixState: 'zero',
        cardClass: 'engine'
      });
    }
    section.appendChild(renderOrientationGrid(piece, color, cycleOrientations));

    return section;
  }

  function init() {
    var rail = document.getElementById('rot-rail');
    for (var i = 0; i < PIECE_TYPES.length; i++) {
      rail.appendChild(buildPieceSection(PIECE_TYPES[i]));
    }
  }

  init();
})();
