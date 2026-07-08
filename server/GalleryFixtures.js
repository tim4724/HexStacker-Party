'use strict';

// UMD: works in Node.js (require), the browser (window.GameEngine.GalleryFixtures),
// and JavaScriptCore/QuickJS on native (tvOS / Android TV). Pure: no wall clock,
// no timers, no DOM, no I/O.
//
// Canonical fixture data for the cross-platform screen gallery
// (scripts/gallery/). Every platform that renders the display — the web test
// harness, tvOS HEXSHOT states, and the Android Roborazzi screenshot tests —
// draws THIS data, so a visual difference between gallery columns is always a
// renderer difference, never a fixture difference.
//
// Game boards are not hand-frozen grids: gameSnapshot() drives the real engine
// (PartyCore) with a fixed seed and a scripted, arithmetic drop sequence, then
// value-copies the result. All three platforms execute this same module inside
// their JS engine (byte-exact per the frame-golden conformance tests), so the
// boards are identical by construction.
(function(exports) {

var PartyCore = ((typeof require !== 'undefined') ? require('./PartyCore.js') : window.GameEngine).PartyCore;
var GameConstants = ((typeof require !== 'undefined') ? require('./constants.js') : window.GameConstants);
var PieceModule = (typeof require !== 'undefined') ? require('./Piece.js') : window.PieceModule;

var SEED = 4207;

// Deterministic PRNG (mulberry32) for fixture placement data — Math.random is
// reserved for the engine's default-seed path and would break reproducibility.
function _rng(seed) {
  var s = seed >>> 0;
  return function() {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    var t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Join-target data mirroring the web harness's historic lobby fake
// (_fakeLobbyQR): the join URL renders as host+code, the QR encodes qrText.
var JOIN = {
  host: 'hexstacker.com/',
  code: 'TEST',
  qrText: 'https://hexstacker.com/TEST12'
};

// Slot order == color index order. Levels are the lobby-badge variety; game
// board levels come from the variant spec instead.
var NAMES = ['Emma', 'Jake', 'Sofia', 'Liam', 'Mia', 'Noah', 'Ava', 'Leo'];
var LOBBY_LEVELS = [3, 1, 5, 2, 4, 6, 2, 1];

// Per-slot lines-counter salt: displayed lines = (level-1)*10 + salt, which
// keeps getLevel() = floor(lines/10) + startLevel pinned to the variant level
// while giving each board a distinct, plausible LINES readout.
var LINES_SALT = [4, 7, 2, 9, 6, 3, 8, 5];

function roster(count) {
  var n = Math.max(0, Math.min(count, NAMES.length));
  var list = [];
  for (var i = 0; i < n; i++) {
    list.push({ id: i, slot: i, name: NAMES[i], level: LOBBY_LEVELS[i] });
  }
  return list;
}

// Named board-state variants — the single source for every gallery game row.
// levels: per-board displayed level (drives the NORMAL/PILLOW/NEON tier).
// ko: slots topped out after the scripted drops. garbage: pending-meter lines.
var VARIANTS = {
  'solo': { players: 1, levels: [1],              elapsed: 75000 },
  'lv1':  { players: 4, levels: [1, 1, 1, 1],     elapsed: 75000 },
  'lv8':  { players: 4, levels: [8, 8, 8, 8],     elapsed: 75000 },
  'lv12': { players: 4, levels: [12, 12, 12, 12], elapsed: 75000 },
  '2p':   { players: 2, levels: [3, 9],           garbage: { 1: 3 }, elapsed: 83000 },
  '3p':   { players: 3, levels: [1, 8, 12],       elapsed: 47000 },
  '4p':   { players: 4, levels: [3, 9, 12, 1],    ko: [3], garbage: { 1: 3 }, elapsed: 132000 },
  '8p':   { players: 8, levels: [3, 9, 12, 1, 5, 8, 2, 12], ko: [5], garbage: { 1: 3, 6: 2 }, elapsed: 154000 }
};

function gameVariant(name) {
  var v = VARIANTS[name];
  return v ? JSON.parse(JSON.stringify(v)) : null;
}

// Advance the frame clock in cap-sized steps so line clears resolve between
// drop rounds (LINE_CLEAR_DELAY_MS < 400) without tripping MAX_FRAME_DELTA_MS.
function step(pc, clock, ms) {
  var stepMs = PartyCore.MAX_FRAME_DELTA_MS;
  for (var t = 0; t < ms; t += stepMs) {
    clock.now += stepMs;
    pc.frame(clock.now);
  }
}

// Build one deterministic mid-game snapshot for a variant spec:
//   { players, levels?|level?, ko?, garbage?, elapsed?, drops? }
// All boards run the scripted drops at startLevel 1 (identical gravity), so the
// tier variants share the same board shapes and differ only in level styling —
// mirroring how the web gallery's tier cards have always compared.
function gameSnapshot(spec) {
  var count = spec.players;
  var levels = [];
  for (var li = 0; li < count; li++) {
    levels.push(spec.levels ? spec.levels[li] : (spec.level || 1));
  }
  var ko = spec.ko || [];
  var drops = (spec.drops != null) ? spec.drops : 10;

  var rosterMap = new Map();
  for (var ri = 0; ri < count; ri++) rosterMap.set(ri, { startLevel: 1 });
  var pc = new PartyCore(rosterMap, SEED);
  pc.init();
  var clock = { now: 0 };
  pc.frame(0); // prime the frame clock

  for (var k = 0; k < drops; k++) {
    for (var i = 0; i < count; i++) {
      if (ko.indexOf(i) >= 0) continue; // KO boards top out separately below
      var rot = (k + i) % 3;
      for (var r = 0; r < rot; r++) pc.processInput(i, 'rotate_cw');
      var shift = ((k * 5 + i * 3) % 9) - 4;
      for (var s = 0; s < Math.abs(shift); s++) {
        pc.processInput(i, shift < 0 ? 'left' : 'right');
      }
      if (k === 2 && i % 2 === 0) pc.processInput(i, 'hold');
      pc.processInput(i, 'hard_drop');
    }
    step(pc, clock, 400);
  }

  // Top out KO'd boards with an unmoved center stack (single column can never
  // form a clearable zigzag, so the top-out is unconditional).
  for (var kj = 0; kj < ko.length; kj++) {
    var koBoard = pc.game.boards.get(ko[kj]);
    var guard = 0;
    while (koBoard && koBoard.alive && guard++ < 60) {
      pc.processInput(ko[kj], 'hard_drop');
      step(pc, clock, 50);
    }
  }

  // Pending-garbage meters.
  if (spec.garbage) {
    for (var gSlot in spec.garbage) {
      var b = pc.game.boards.get(parseInt(gSlot, 10));
      if (b && b.alive) {
        b.addPendingGarbage(spec.garbage[gSlot], (parseInt(gSlot, 10) * 3 + 5) % GameConstants.COLS);
      }
    }
  }

  // Pin each board's displayed level/lines to the variant spec (level is
  // derived as floor(lines/10) + startLevel with startLevel 1).
  for (var pi = 0; pi < count; pi++) {
    var board = pc.game.boards.get(pi);
    if (board) board.lines = (levels[pi] - 1) * 10 + LINES_SALT[pi];
  }

  var snap = pc.snapshot();
  snap.elapsed = (spec.elapsed != null) ? spec.elapsed : 75000;
  return snap;
}

// Frozen placements for the falling-piece welcome/lobby background, shared by
// every platform's gallery shots. The live animation differs per platform in
// WHEN pieces are on screen (web spawns its pool above the viewport, tvOS
// pre-seeds across it), so a timed capture freezes each at a different moment;
// rendering this fixed steady-state frame instead makes the lobby columns
// comparable. Reference space is 1920x1080, y-down; consumers scale to their
// viewport. cells are engine-rotated axial [q, r] offsets; typeId indexes the
// shared piece palette; size is the hex circumradius; opacity matches the live
// animation's 0.14-0.22 band.
function ambientPieces() {
  var rnd = _rng(9151);
  var keys = Object.keys(PieceModule.PIECES);
  var SIZES = [12, 16, 20, 24, 28, 32];
  var COLS = 4, ROWS = 4;
  var W = 1920;
  var Y_TOP = -60, Y_SPAN = 1200; // spill past both edges so the frame reads mid-fall
  var cellW = W / COLS;
  var cellH = Y_SPAN / ROWS;
  var list = [];
  for (var r = 0; r < ROWS; r++) {
    for (var c = 0; c < COLS; c++) {
      var key = keys[Math.floor(rnd() * keys.length)];
      var rot = Math.floor(rnd() * 6);
      var cells = PieceModule.PIECES[key];
      for (var k = 0; k < rot; k++) {
        var next = [];
        for (var i = 0; i < cells.length; i++) {
          // rotateCW in axial: (q, r) -> (-r, q + r), matching the engine.
          next.push([-cells[i][1], cells[i][0] + cells[i][1]]);
        }
        cells = next;
      }
      var copy = [];
      for (var j = 0; j < cells.length; j++) copy.push([cells[j][0], cells[j][1]]);
      list.push({
        typeId: GameConstants.PIECE_TYPE_TO_ID[key],
        cells: copy,
        x: cellW * (c + 0.1 + rnd() * 0.8),
        y: Y_TOP + cellH * (r + 0.1 + rnd() * 0.8),
        size: SIZES[Math.floor(rnd() * SIZES.length)],
        opacity: 0.14 + rnd() * 0.08
      });
    }
  }
  return list;
}

// Canonical results roster — the exact ranking the web harness has always
// rendered (rank i+1, lines 30-3i, level counting down to 1).
function results(count) {
  var n = Math.max(1, Math.min(count, NAMES.length));
  var list = [];
  for (var i = 0; i < n; i++) {
    list.push({
      playerId: i,
      playerName: NAMES[i],
      colorIndex: i,
      rank: i + 1,
      lines: 30 - i * 3,
      level: 1 + (n - 1 - i)
    });
  }
  return { elapsed: 123456, results: list };
}

exports.GalleryFixtures = {
  SEED: SEED,
  JOIN: JOIN,
  NAMES: NAMES,
  roster: roster,
  gameVariant: gameVariant,
  gameSnapshot: gameSnapshot,
  ambientPieces: ambientPieces,
  results: results
};

})(typeof module !== 'undefined' ? module.exports : (window.GameEngine = window.GameEngine || {}));
