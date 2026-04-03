'use strict';

// UMD: works in Node.js (require) and browser (window.HexConstants)
(function(exports) {

var constants = (typeof require !== 'undefined') ? require('./constants') : window.GameConstants;

// Grid dimensions
var HEX_COLS = 11;
var HEX_TOTAL_ROWS = 25;   // 4 buffer + 21 visible
var HEX_BUFFER_ROWS = 4;
var HEX_VISIBLE_ROWS = 21;

// 7 hex piece types (1-indexed to match grid cell values)
// All 4-hex pieces
var HEX_PIECE_TYPES = ['L', 'S', 'T', 'F', 'Fm', 'I4', 'Tp'];
var HEX_PIECE_TYPE_TO_ID = { L: 1, S: 2, T: 3, F: 4, Fm: 5, I4: 6, Tp: 7 };
var HEX_GARBAGE_CELL = 9;

// ===================== ZIGZAG CLEAR DETECTION =====================
// Shared by engine (HexPlayerBoard) and renderer (HexBoardRenderer clear preview).

// Check if a single zigzag line is full in the given grid.
// type='down': same row index across all cols.
// type='up': even cols at row r, odd cols at row r-1.
// isFilled(col, row) returns truthy if cell counts as filled.
// Returns array of [col, row] cells or null.
function checkZigzag(r, type, cols, totalRows, isFilled) {
  for (var col = 0; col < cols; col++) {
    var row = (type === 'up' && (col & 1)) ? r - 1 : r;
    if (row < 0 || row >= totalRows) return null;
    if (!isFilled(col, row)) return null;
  }
  var cells = [];
  for (var c = 0; c < cols; c++) {
    var rr = (type === 'up' && (c & 1)) ? r - 1 : r;
    cells.push([c, rr]);
  }
  return cells;
}

// Find all clearable zigzag lines (both directions) with bottom-first
// non-overlapping selection. Returns { linesCleared, clearCells }.
// isFilled(col, row) returns truthy if cell counts as filled.
// ghostContributes(col, row) returns truthy if the cell is a ghost cell
// (optional — pass null to skip ghost filtering, used by engine).
function findClearableZigzags(cols, totalRows, isFilled, ghostContributes, minRow) {
  var allZigzags = [];
  var startRow = minRow != null ? minRow : 0;

  for (var r = startRow; r < totalRows; r++) {
    var down = checkZigzag(r, 'down', cols, totalRows, isFilled);
    if (down) {
      if (!ghostContributes || down.some(function(c) { return ghostContributes(c[0], c[1]); })) {
        allZigzags.push(down);
      }
    }
    if (r >= 1) {
      var up = checkZigzag(r, 'up', cols, totalRows, isFilled);
      if (up) {
        if (!ghostContributes || up.some(function(c) { return ghostContributes(c[0], c[1]); })) {
          allZigzags.push(up);
        }
      }
    }
  }

  // Sort bottom-first: higher max row = lower on board = higher priority.
  // Tie-break by min row so zigzag-down (all at row r) wins over zigzag-up (spans r-1..r).
  allZigzags.sort(function(a, b) {
    var aMax = 0, bMax = 0, aMin = Infinity, bMin = Infinity;
    for (var i = 0; i < a.length; i++) { aMax = Math.max(aMax, a[i][1]); aMin = Math.min(aMin, a[i][1]); }
    for (var j = 0; j < b.length; j++) { bMax = Math.max(bMax, b[j][1]); bMin = Math.min(bMin, b[j][1]); }
    return (bMax - aMax) || (bMin - aMin);
  });

  // Greedily select non-overlapping zigzags
  var clearCells = {};
  var linesCleared = 0;
  for (var zi = 0; zi < allZigzags.length; zi++) {
    var zag = allZigzags[zi];
    var overlaps = false;
    for (var ci = 0; ci < zag.length; ci++) {
      if (clearCells[zag[ci][0] + ',' + zag[ci][1]]) { overlaps = true; break; }
    }
    if (!overlaps) {
      linesCleared++;
      for (var cj = 0; cj < zag.length; cj++) {
        clearCells[zag[cj][0] + ',' + zag[cj][1]] = true;
      }
    }
  }

  return { linesCleared: linesCleared, clearCells: clearCells };
}

// ===================== HEX GEOMETRY =====================
// Shared by DisplayUI, HexBoardRenderer, and HexUIRenderer.
function computeHexGeometry(boardCols, visRows, cellSize) {
  // hexSize = circumradius that fits boardCols flat-top hexes within cellSize * boardCols width
  var hexSize = boardCols * cellSize / (1.5 * boardCols + 0.5);
  var hexH = Math.sqrt(3) * hexSize;
  var colW = 1.5 * hexSize;
  return {
    hexSize: hexSize,
    hexH: hexH,
    colW: colW,
    boardWidth: colW * (boardCols - 1) + 2 * hexSize,
    boardHeight: hexH * (visRows - 1) + hexH + hexH * 0.5
  };
}

// Trace the closed outline of a hex board on a canvas context.
// bx, by: board origin. hs: hexSize. hexH: hex height. colW: column spacing.
// cols: column count. visRows: visible row count.
// Produces a single closed path suitable for both stroking and clipping.
function traceHexOutline(ctx, bx, by, hs, hexH, colW, cols, visRows) {
  var lastRow = visRows - 1;
  var lastCol = cols - 1;

  function hc(col, row) {
    return { x: bx + colW * col + hs, y: by + hexH * (row + 0.5 * (col & 1)) + hexH / 2 };
  }
  function hv(cx, cy, i) {
    var a = Math.PI / 3 * i;
    return { x: cx + hs * Math.cos(a), y: cy + hs * Math.sin(a) };
  }

  ctx.beginPath();
  // Top border: left-to-right across row 0
  var p0 = hc(0, 0);
  var v = hv(p0.x, p0.y, 4);
  ctx.moveTo(v.x, v.y);
  for (var c = 0; c <= lastCol; c++) {
    var pt = hc(c, 0);
    v = hv(pt.x, pt.y, 5);
    ctx.lineTo(v.x, v.y);
    if (c < lastCol) {
      if (c % 2 === 0) {
        v = hv(pt.x, pt.y, 0);
        ctx.lineTo(v.x, v.y);
      } else {
        var pn = hc(c + 1, 0);
        v = hv(pn.x, pn.y, 4);
        ctx.lineTo(v.x, v.y);
      }
    }
  }
  // Right wall: top-to-bottom along last col
  for (var r = 0; r <= lastRow; r++) {
    var pr = hc(lastCol, r);
    v = hv(pr.x, pr.y, 0); ctx.lineTo(v.x, v.y);
    v = hv(pr.x, pr.y, 1); ctx.lineTo(v.x, v.y);
  }
  // Bottom border: right-to-left across last row
  for (var c2 = lastCol; c2 >= 0; c2--) {
    var pb = hc(c2, lastRow);
    v = hv(pb.x, pb.y, 2);
    ctx.lineTo(v.x, v.y);
    if (c2 > 0) {
      if (c2 % 2 === 0) {
        var pp = hc(c2 - 1, lastRow);
        v = hv(pp.x, pp.y, 1);
        ctx.lineTo(v.x, v.y);
      } else {
        v = hv(pb.x, pb.y, 3);
        ctx.lineTo(v.x, v.y);
      }
    }
  }
  // Left wall: bottom-to-top along col 0
  for (var r2 = lastRow; r2 >= 0; r2--) {
    var pl = hc(0, r2);
    v = hv(pl.x, pl.y, 3); ctx.lineTo(v.x, v.y);
    v = hv(pl.x, pl.y, 4); ctx.lineTo(v.x, v.y);
  }
  ctx.closePath();
}

exports.traceHexOutline = traceHexOutline;
exports.computeHexGeometry = computeHexGeometry;
exports.HEX_COLS = HEX_COLS;
exports.HEX_TOTAL_ROWS = HEX_TOTAL_ROWS;
exports.HEX_BUFFER_ROWS = HEX_BUFFER_ROWS;
exports.HEX_VISIBLE_ROWS = HEX_VISIBLE_ROWS;
exports.HEX_PIECE_TYPES = HEX_PIECE_TYPES;
exports.HEX_PIECE_TYPE_TO_ID = HEX_PIECE_TYPE_TO_ID;
exports.HEX_GARBAGE_CELL = HEX_GARBAGE_CELL;
exports.findClearableZigzags = findClearableZigzags;

})(typeof module !== 'undefined' ? module.exports : (window.HexConstants = {}));
