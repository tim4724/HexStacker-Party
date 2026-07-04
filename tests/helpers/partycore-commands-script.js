'use strict';

// Deterministic PartyCore command-VOCABULARY driver.
//
// The shared buildTimeline (engine-golden-script.js) deliberately stays at
// level 1 / single-line clears, so it never exercises two host-effect
// commands: garbageCancelled (defence) and garbageSent (multi-line attack).
// This driver pins those two with a set
// of small, hermetic scenarios — each a FRESH PartyCore so clear-animation /
// garbage-delay timers never bleed across scenarios — recording per frame the
// { deltaMs, events, commands } that frame() produced. The matching test
// (tests/partycore-commands.test.js) replays it and deep-asserts against a
// committed fixture, plus gates that every target command type actually appears.
//
// Determinism: no wall clock, no Math.random. Boards are seeded direct grid
// setups (the same board.grid / board.addPendingGarbage entry points the engine
// golden uses to inject garbage) plus an exactly-placed currentPiece, so a
// hard_drop locks with ZERO drop distance and completes precisely the engineered
// rows. The one RNG draw on the send path (GarbageManager.generateGapColumn) is
// NOT recorded — garbage_sent carries only { senderId, toId, lines } — so the
// fixture is RNG-free.

const { PartyCore } = require('../../server/PartyCore');
const { Piece } = require('../../server/Piece');
const GameConstants = require('../../server/constants');

const COLS = GameConstants.COLS;
const TOTAL_ROWS = GameConstants.TOTAL_ROWS;
const GARBAGE_CELL = GameConstants.GARBAGE_CELL;
const FLOOR_ROW = TOTAL_ROWS - 1;   // bottom grid row (a hard drop can't fall past it)

const SEED = 7;
const PLAYER_IDS = ['p1', 'p2'];

function newRoster() {
  return new Map(PLAYER_IDS.map((id) => [id, { startLevel: 1 }]));
}

// Build a piece, rotate it `rotations` times, seat it at `anchorCol`, and shift
// its anchor so the piece's LOWEST absolute block rests on `bottomRow`. With
// bottomRow == FLOOR_ROW the piece is on the floor, so a subsequent hard_drop
// can't fall further and locks it exactly here. Pure geometry — no grid state.
function placedPiece(type, rotations, anchorCol, bottomRow) {
  const piece = new Piece(type);
  for (let i = 0; i < rotations; i++) piece.rotateCW();
  piece.anchorCol = anchorCol;
  piece.anchorRow = 0;
  let maxRow = 0;
  const blocks = piece.getAbsoluteBlocks();
  for (let i = 0; i < blocks.length; i++) if (blocks[i][1] > maxRow) maxRow = blocks[i][1];
  piece.anchorRow += (bottomRow - maxRow);
  return piece;
}

// Fill `fillRows` (absolute grid rows) completely, then carve out exactly the
// seated piece's cells and make it the current piece. The only empty cells left
// in those rows ARE the piece's blocks, so locking it (hard_drop, zero drop
// distance) completes precisely `fillRows.length` down-zigzag lines.
function seatClearPiece(board, fillRows, piece) {
  for (let ri = 0; ri < fillRows.length; ri++) {
    const row = board.grid[fillRows[ri]];
    for (let c = 0; c < COLS; c++) row[c] = GARBAGE_CELL;
  }
  const blocks = piece.getAbsoluteBlocks();
  for (let i = 0; i < blocks.length; i++) board.grid[blocks[i][1]][blocks[i][0]] = 0;
  board.currentPiece = piece;
}

// Run one scenario on a fresh PartyCore: prime the frame clock (the prime frame
// is intentionally NOT recorded), let `build` drive inputs +
// record frames, and return the recorded steps.
function runScenario(build) {
  const pc = new PartyCore(newRoster(), SEED);
  pc.init();
  pc.frame(0); // prime clock (0 delta); unrecorded
  const steps = [];
  const recordFrame = (deltaMs) => {
    const f = pc.frame(deltaMs);
    steps.push({ deltaMs, events: f.events, commands: f.commands });
  };
  build(pc, recordFrame);
  return steps;
}

// garbageCancelled: queue board-pending garbage (the same addPendingGarbage entry
// the engine golden injects through), then have p1 clear a line. handleLineClear
// cancels the board-pending garbage first and emits garbage_cancelled.
function buildGarbageCancelled(pc, recordFrame) {
  const board = pc.game.boards.get('p1');
  board.addPendingGarbage(1, 4);
  seatClearPiece(board, [FLOOR_ROW], placedPiece('V3', 0, 3, FLOOR_ROW));
  pc.processInput('p1', 'hard_drop');
  recordFrame(16);   // line_clear cancels the 1 pending line -> garbageCancelled
}

// garbageSent: a single piece can't double-clear in natural play (a <=4-cell
// piece vs 9-cell zigzags), so the two bottom rows are pre-filled and the seated
// 'o' tetromino fills the only gap across both. The >=2 clear sends garbage to
// p2 (GARBAGE_TABLE[2] = 1) -> garbage_sent.
function buildGarbageSent(pc, recordFrame) {
  const board = pc.game.boards.get('p1');
  seatClearPiece(board, [FLOOR_ROW - 1, FLOOR_ROW], placedPiece('o', 1, 4, FLOOR_ROW));
  pc.processInput('p1', 'hard_drop');
  recordFrame(16);   // double clear -> garbageSent (p1 -> p2, 1 line)
}

function runCommandVocabularyScript() {
  return {
    seed: SEED,
    players: PLAYER_IDS.slice(),
    scenarios: [
      { name: 'garbageCancelled', steps: runScenario(buildGarbageCancelled) },
      { name: 'garbageSent', steps: runScenario(buildGarbageSent) },
    ],
  };
}

module.exports = { runCommandVocabularyScript };
