'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Piece } = require('../server/Piece');

// UIRenderer's MINI_PIECES should match Piece.js rotation-0 shapes.
// We verify by comparing normalized block coordinates.
describe('MINI_PIECES consistency with Piece.js', () => {
  // Expected mini pieces (from UIRenderer.js) — rotation 0 shapes
  const MINI_PIECES = {
    I: [[0,1],[1,1],[2,1],[3,1]],
    O: [[0,0],[1,0],[0,1],[1,1]],
    T: [[0,1],[1,1],[2,1],[1,0]],
    S: [[1,0],[2,0],[0,1],[1,1]],
    Z: [[0,0],[1,0],[1,1],[2,1]],
    J: [[0,0],[0,1],[1,1],[2,1]],
    L: [[2,0],[0,1],[1,1],[2,1]]
  };

  function normalize(blocks) {
    var sorted = blocks.slice().sort(function(a, b) {
      return a[0] - b[0] || a[1] - b[1];
    });
    var minC = Math.min.apply(null, sorted.map(function(b) { return b[0]; }));
    var minR = Math.min.apply(null, sorted.map(function(b) { return b[1]; }));
    return sorted.map(function(b) { return [b[0] - minC, b[1] - minR]; });
  }

  for (const type of ['I', 'O', 'T', 'S', 'Z', 'J', 'L']) {
    test(type + ' mini shape matches Piece.js rotation 0', () => {
      var piece = new Piece(type);
      var canonical = piece.getBlocks(); // rotation 0
      assert.deepStrictEqual(
        normalize(MINI_PIECES[type]),
        normalize(canonical),
        type + ' shapes do not match'
      );
    });
  }
});
