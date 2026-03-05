'use strict';

const BOARD_WIDTH = 10;
const BOARD_HEIGHT = 24; // 20 visible + 4 buffer
const VISIBLE_HEIGHT = 20;
const BUFFER_ROWS = 4;

// Gravity: frames per cell drop at each level (60fps base)
// Standard guideline gravity curve
const GRAVITY_TABLE = [
  48, 43, 38, 33, 28, 23, 18, 13, 8, 6, // levels 0-9
  5, 5, 5, 4, 4, 4, 3, 3, 3, 2,          // levels 10-19
  2, 2, 2, 2, 2, 2, 2, 2, 2, 1           // levels 20-29
];

const SOFT_DROP_MULTIPLIER = 20;
const LOCK_DELAY_MS = 500;
const MAX_LOCK_RESETS = 15;
const LINE_CLEAR_DELAY_MS = 400; // Delay before cleared rows are removed (< client animation 500ms for graceful fade)
const MAX_DROPS_PER_TICK = 5;    // Safety cap to prevent teleporting

// Timing
const LOGIC_TICK_MS = 1000 / 60;    // 60Hz game logic

// Scoring (standard guideline)
const LINE_CLEAR_SCORES = {
  1: 100,   // single
  2: 300,   // double
  3: 500,   // triple
  4: 800    // tetris
};

const TSPIN_SCORES = {
  0: 400,   // t-spin no lines
  1: 800,   // t-spin single
  2: 1200,  // t-spin double
  3: 1600   // t-spin triple
};

const TSPIN_MINI_SCORES = {
  0: 100,
  1: 200,
  2: 400
};

const COMBO_TABLE = [0, 50, 50, 100, 100, 150, 150, 200, 200, 250, 250, 300, 300, 350];
const BACK_TO_BACK_MULTIPLIER = 1.5;

// Garbage lines sent for competitive mode
const GARBAGE_TABLE = {
  1: 0,  // single sends 0
  2: 1,  // double sends 1
  3: 2,  // triple sends 2
  4: 4   // tetris sends 4
};

const TSPIN_GARBAGE_MULTIPLIER = 2;
const COMBO_GARBAGE = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 4, 5];

// Room settings
const MAX_PLAYERS = 4;
const ROOM_CODE_LENGTH = 4;
// Countdown
const COUNTDOWN_SECONDS = 3;

// Piece types (1-indexed to match grid cell values)
const PIECE_TYPES = ['I', 'J', 'L', 'O', 'S', 'T', 'Z'];
const PIECE_TYPE_TO_ID = { I: 1, J: 2, L: 3, O: 4, S: 5, T: 6, Z: 7 };
const GARBAGE_CELL = 8;

module.exports = {
  BOARD_WIDTH, BOARD_HEIGHT, VISIBLE_HEIGHT, BUFFER_ROWS,
  GRAVITY_TABLE, SOFT_DROP_MULTIPLIER, LOCK_DELAY_MS, MAX_LOCK_RESETS,
  LINE_CLEAR_DELAY_MS, MAX_DROPS_PER_TICK,
  LOGIC_TICK_MS,
  LINE_CLEAR_SCORES, TSPIN_SCORES, TSPIN_MINI_SCORES,
  COMBO_TABLE, BACK_TO_BACK_MULTIPLIER,
  GARBAGE_TABLE, TSPIN_GARBAGE_MULTIPLIER, COMBO_GARBAGE,
  MAX_PLAYERS, ROOM_CODE_LENGTH,
  COUNTDOWN_SECONDS,
  PIECE_TYPES, PIECE_TYPE_TO_ID, GARBAGE_CELL
};
