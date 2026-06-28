'use strict';

// Deterministic engine "golden corpus" driver.
//
// Single source of truth shared by the recorder (RECORD_GOLDEN=1) and the
// replay test (tests/engine-golden.test.js). Builds a fixed Game (fixed seed,
// 2-player roster), runs a scripted, clock-free timeline of inputs + updates,
// and after every update() captures a compact per-board snapshot plus the
// events emitted that step. Because record and replay run the SAME script in
// the SAME engine, the output is bit-for-bit reproducible and the fixture is
// asserted with exact deep-equality (see the test for the JSC float caveat).
//
// The script deliberately exercises gravity, locking, line clears, hold,
// hard_drop and garbage delivery, but NEVER exercises soft-drop auto-end or
// rapid (<150ms) hard-drop throttling — those are the edges Phase 2 changes,
// so the golden must stay green across the engine move.

const { Game } = require('../../server/Game');
const { COLS } = require('../../server/constants');

const SEED = 534;                  // pinned for coverage (locks/clears/hold/KO/garbage); re-record if changed
const PLAYER_IDS = ['p1', 'p2'];

// Keep at least this many ms of update() time between a single player's hard
// drops. Phase 2 adds a 150ms hard-drop cooldown at the Game input layer; a
// scripted drop inside that window would be silently swallowed and diverge the
// golden. 200 clears 150 with margin. (With strict player alternation and the
// per-turn update block below, the real gap is ~260ms, so this guard never
// actually trips — it is belt-and-suspenders for determinism across Phase 2.)
const HARD_DROP_GUARD_MS = 200;

// Fixed deltaMs cadence (mix of 60fps frames, a 33ms hitch, and a 50ms cap-
// sized frame) so gravity accumulation, lock timers, the 400ms line-clear
// delay and the 2000ms garbage delay all get ticked through.
const DELTAS = [16, 16, 33, 16, 50];

// Build the operation timeline as a flat list of:
//   ['input', playerId, action]   (action: left|right|rotate_cw|hard_drop|hold)
//   ['garbage', playerId, lines, gapColumn]   (queues pending garbage on a board)
//   ['update', deltaMs]
// No engine state is read while building, so the timeline is a pure function of
// its loop indices — fully deterministic and decoupled from engine internals.
//
// Garbage note: a garbage SEND requires a multi-line (double/triple) clear, and
// in this hex board a single <=4-cell piece can never complete two 9-cell
// zigzags at once, so doubles are unreachable through natural play (the send
// path is covered by the dedicated garbage*.test.js suite). To still pin the
// substantive garbage-APPLY engine code (applyGarbage: rising rows + gap-column
// zigzag-avoidance), the script injects pending garbage via the same
// board.addPendingGarbage entry point Game.update uses when delivering ready
// garbage; it is consumed on the player's next lock (_applyPendingGarbage).
function buildTimeline() {
  const ops = [];
  let di = 0;
  const msSince = { p1: 1e9, p2: 1e9 }; // large => first drop per player allowed

  function update() {
    const d = DELTAS[di++ % DELTAS.length];
    ops.push(['update', d]);
    msSince.p1 += d;
    msSince.p2 += d;
  }
  function input(id, action) {
    ops.push(['input', id, action]);
  }

  const TURNS = 90;
  for (let t = 0; t < TURNS; t++) {
    const id = PLAYER_IDS[t % 2];

    // Inject garbage onto the player who is NOT placing this turn, so it sits
    // queued (visible as pendingGarbageLines>0) until that player's next lock
    // applies it — exercising both the queued and the applied states.
    if (t === 9) ops.push(['garbage', 'p1', 2, 4]);
    if (t === 12) ops.push(['garbage', 'p2', 3, 1]);

    // Position deterministically: shove to the left wall (over-moving past the
    // edge is a harmless no-op), then step right to a target column. Lands the
    // piece at a known column regardless of spawn column/orientation. Per-player
    // stride of 2 walks each board's placements across all 9 columns so rows
    // fill and zigzags clear instead of one column topping out early.
    for (let k = 0; k < COLS; k++) input(id, 'left');
    const targetCol = (Math.floor(t / 2) * 2) % COLS;
    for (let k = 0; k < targetCol; k++) input(id, 'right');

    // Rotation variety (0/1/2 CW) exercises the kick/cycle paths.
    for (let k = 0; k < t % 3; k++) input(id, 'rotate_cw');

    // Hold occasionally (swap in/out) without letting it dominate the run.
    if (t % 11 === 5) input(id, 'hold');

    // Hard drop — gated by the guard so we never script a sub-150ms repeat.
    if (msSince[id] >= HARD_DROP_GUARD_MS) {
      input(id, 'hard_drop');
      msSince[id] = 0;
    }

    // Advance time: 5 frames/turn so gravity, lock timers, the line-clear
    // animation and garbage delays all tick between placements.
    for (let f = 0; f < 5; f++) update();
  }

  // Long tail: drain in-flight timers (400ms clear animations, 2000ms garbage
  // delays) so their effects land inside the recorded window.
  for (let f = 0; f < 200; f++) update();

  return ops;
}

function clone(x) {
  return JSON.parse(JSON.stringify(x));
}

// FNV-1a 32-bit hash of the full grid (incl. buffer rows), row-major. Compact
// and order-sensitive; a single changed cell flips the hash so grid drift is
// detected without storing 19x9 cells per board per step.
function hashGrid(grid) {
  let h = 0x811c9dc5;
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r];
    for (let c = 0; c < row.length; c++) {
      h ^= (row[c] & 0xff);
      h = Math.imul(h, 0x01000193);
    }
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function snapshotBoard(game, id) {
  const b = game.boards.get(id);
  const p = b.currentPiece;
  return {
    id,
    gridHash: hashGrid(b.grid),
    piece: p
      ? { type: p.type, typeId: p.typeId, anchorCol: p.anchorCol, anchorRow: p.anchorRow, rotId: p._rotId }
      : null,
    holdPiece: b.holdPiece,
    lines: b.lines,
    alive: b.alive,
    lockTimerActive: b.lockTimer !== null,   // boolean per spec (lockTimer != null)
    gravityCounter: b.gravityCounter,         // exact float; pinned same-process
    clearing: b.clearingCells !== null,
    pendingGarbageLines: b.pendingGarbage.reduce((s, g) => s + g.lines, 0),
  };
}

// Run the full scripted timeline against a fresh Game and return the recorded
// corpus: { seed, players, steps } where each step is one update() with the
// post-update board snapshots and the events emitted since the previous step
// (which includes events from any processInput calls made in between).
function runGoldenScript(seedOverride) {
  const seed = seedOverride == null ? SEED : seedOverride;
  const eventBuffer = [];
  const roster = new Map(PLAYER_IDS.map((id) => [id, { startLevel: 1 }]));
  const game = new Game(roster, {
    onEvent: (e) => eventBuffer.push(clone(e)),
    onGameEnd: (r) => eventBuffer.push(clone({ type: 'game_end', elapsed: r.elapsed, results: r.results })),
  }, seed);
  game.init();

  const timeline = buildTimeline();
  const steps = [];
  let postEnd = 0;

  for (const op of timeline) {
    if (op[0] === 'input') {
      game.processInput(op[1], op[2]);
    } else if (op[0] === 'garbage') {
      const b = game.boards.get(op[1]);
      if (b && b.alive) b.addPendingGarbage(op[2], op[3]);
    } else {
      game.update(op[1]);
      steps.push({
        deltaMs: op[1],
        boards: PLAYER_IDS.map((id) => snapshotBoard(game, id)),
        events: eventBuffer.splice(0),
      });
      // Once the game has ended, record a short stable tail and stop so the
      // fixture doesn't balloon with hundreds of identical post-end frames.
      if (game.ended && ++postEnd >= 5) break;
    }
  }

  return { seed, players: PLAYER_IDS.slice(), steps };
}

module.exports = { runGoldenScript, buildTimeline, SEED, PLAYER_IDS };
