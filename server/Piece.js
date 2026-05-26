'use strict';

// UMD: works in Node.js (require) and browser (window.PieceModule)
// Flat-top hexagons with odd-q offset coordinates.
(function(exports) {

var constants = (typeof require !== 'undefined') ? require('./constants') : window.GameConstants;
var PIECE_TYPE_TO_ID = constants.PIECE_TYPE_TO_ID;
var COLS = constants.COLS;

// ===================== HEX MATH (flat-top, odd-q offset) =====================
function offsetToAxial(col, row) {
  return { q: col, r: row - ((col - (col & 1)) >> 1) };
}

function axialToOffset(q, r) {
  return { col: q, row: r + ((q - (q & 1)) >> 1) };
}

// Scratch arrays for getAbsoluteBlocks — avoids allocation on every call.
// Sized for the largest piece in the bag (4-cell tetrominoes); the
// non-allocating fast path expands on demand for any future size.
var _absBlocksScratch = [[0,0],[0,0],[0,0],[0,0]];

// ===================== PIECE DEFINITIONS =====================
// Casual mixed bag: 3 trominoes (3-cell) + 3 small tetrominoes (4-cell).
// Trominoes lower mental-rotation load; tetrominoes preserve challenge.
//
// d and b are starter geometries — letter silhouettes are approximate in
// flat-top odd-q with only 4 cells. Iterate visually if needed.
// cells[0] must NOT be the (0,0) anchor — rotation keeps the anchor fixed,
// so an anchor-first piece's cells[0] is invariant across rotations and the
// renderer's ghost-preview cache can't tell rotations apart. List a non-anchor
// cell first for every piece. (See "rotating a piece without moving it" test.)
var PIECES = {
  I3: [[-1,0],[0,0],[1,0]],            // straight 3-line, one rotation per hex axis
  V3: [[-1,0],[0,0],[0,1]],            // 60° bend chain; anchor at the MIDDLE of the chain so rotation pivots in place instead of swinging around an endpoint
  T3: [[1,0],[0,0],[0,1]],             // tight 3-triangle (3 mutually-adjacent cells)
  o:  [[-1,0],[0,0],[0,-1],[1,-1]],    // compact 4-cell rhombus — safe placement piece
  d:  [[0,-1],[0,0],[0,1],[1,0]],      // 3-cell vertical stem + mid-right bulge
  b:  [[0,-1],[0,0],[0,1],[-1,1]],     // visual mirror of d — bulge at offset (-1,0); axial (-1,1) here is the true reflection, NOT axial (-1,0) which is just d's r3 rotation
};

// No piece in the casual bag spans more than 1 cell from its anchor in any
// rotation, so a ±1 kick is always sufficient to recover from a wall hit.
var KICKS = [
  [0,0],
  [-1,0], [1,0], [0,-1], [0,1],
  [-1,-1], [1,-1], [-1,1], [1,1]
];

// ===================== HEX PIECE CLASS =====================
class Piece {
  constructor(type) {
    this.type = type;
    this.typeId = PIECE_TYPE_TO_ID[type];
    this.cells = PIECES[type].map(function(c) { return { q: c[0], r: c[1] }; });
    this.anchorCol = COLS >> 1;  // spawn at horizontal center
    this.anchorRow = 0;
    this._rotId = 0;    // incremented on rotate, used for ghost cache key
    // In odd-q (flat-top), column parity affects offset row mapping,
    // so we must compute the actual minimum offset row of all blocks.
    this._adjustAnchorRow();
    // Lateral moves in flat-top hex are diagonal (half a cell up or down).
    // _anchorY is the piece's "resting" visual y in half-hex units. Lateral
    // moves oscillate between y == _anchorY and y == _anchorY - 1, biased up,
    // so holding a column never costs altitude. Gravity/rotation reset it.
    this._anchorY = 2 * this.anchorRow + (this.anchorCol & 1);
  }

  _resetAnchorY() {
    this._anchorY = 2 * this.anchorRow + (this.anchorCol & 1);
  }

  // Ensure no block has a negative offset row by raising anchorRow
  _adjustAnchorRow() {
    var minOffRow = 0;
    var a = offsetToAxial(this.anchorCol, this.anchorRow);
    for (var i = 0; i < this.cells.length; i++) {
      var off = axialToOffset(a.q + this.cells[i].q, a.r + this.cells[i].r);
      if (off.row < minOffRow) minOffRow = off.row;
    }
    if (minOffRow < 0) this.anchorRow -= minOffRow;
  }

  getAbsoluteBlocks() {
    var ac = this.anchorCol, ar = this.anchorRow;
    var aq = ac, aRr = ar - ((ac - (ac & 1)) >> 1);
    var result = [];
    for (var i = 0; i < this.cells.length; i++) {
      var cq = aq + this.cells[i].q;
      var cr = aRr + this.cells[i].r;
      result.push([cq, cr + ((cq - (cq & 1)) >> 1)]);
    }
    return result;
  }

  // Non-allocating version for hot paths (isValidPosition, lockPiece).
  // Returns a shared scratch array — caller must consume before the next call.
  // Scratch length is normalized to this.cells.length each call so a 3-cell
  // tromino doesn't expose stale entries left over from a previous 4-cell
  // piece (callers iterate `blocks.length`).
  _absoluteBlocksFast() {
    var n = this.cells.length;
    while (_absBlocksScratch.length < n) _absBlocksScratch.push([0, 0]);
    var ac = this.anchorCol, ar = this.anchorRow;
    var aq = ac, aRr = ar - ((ac - (ac & 1)) >> 1);
    for (var i = 0; i < n; i++) {
      var cq = aq + this.cells[i].q;
      var cr = aRr + this.cells[i].r;
      _absBlocksScratch[i][0] = cq;
      _absBlocksScratch[i][1] = cr + ((cq - (cq & 1)) >> 1);
    }
    _absBlocksScratch.length = n;
    return _absBlocksScratch;
  }

  clone() {
    var p = Object.create(Piece.prototype);
    p.type = this.type;
    p.typeId = this.typeId;
    p.cells = this.cells.map(function(c) { return { q: c.q, r: c.r }; });
    p.anchorCol = this.anchorCol;
    p.anchorRow = this.anchorRow;
    p._rotId = this._rotId;
    p._anchorY = this._anchorY;
    return p;
  }

  // Mutates cells in place — call on a clone() to preserve the original.
  rotateCW() {
    this._rotId++;
    for (var i = 0; i < this.cells.length; i++) {
      var q = this.cells[i].q, r = this.cells[i].r;
      this.cells[i].q = -r;
      this.cells[i].r = q + r;
    }
  }

  rotateCCW() {
    this._rotId++;
    for (var i = 0; i < this.cells.length; i++) {
      var q = this.cells[i].q, r = this.cells[i].r;
      this.cells[i].q = q + r;
      this.cells[i].r = -q;
    }
  }
}

// Drop the piece by repeatedly incrementing anchorRow until any block would
// leave the grid or hit a filled cell. Mutates anchorRow in place; does not
// touch _anchorY (rendering-only, irrelevant for ghost/preview callers).
// Shared by PlayerBoard._ghostOf and the display test harness so the gallery
// matches in-game ghost placement.
function dropToFloor(piece, grid, totalRows, cols) {
  while (piece.anchorRow + 1 < totalRows) {
    piece.anchorRow += 1;
    var blocks = piece._absoluteBlocksFast();
    var valid = true;
    for (var i = 0; i < blocks.length; i++) {
      var col = blocks[i][0], row = blocks[i][1];
      if (col < 0 || col >= cols || row < 0 || row >= totalRows || grid[row][col] !== 0) {
        valid = false; break;
      }
    }
    if (!valid) { piece.anchorRow -= 1; return piece; }
  }
  return piece;
}

exports.PIECES = PIECES;
exports.KICKS = KICKS;
exports.Piece = Piece;
exports.dropToFloor = dropToFloor;
exports.offsetToAxial = offsetToAxial;
exports.axialToOffset = axialToOffset;

})(typeof module !== 'undefined' ? module.exports : (window.PieceModule = {}));
