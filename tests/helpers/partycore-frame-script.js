'use strict';

// Deterministic PartyCore frame() "golden corpus" driver + a matched plain-Game
// reference for cross-validation.
//
// Mirrors tests/helpers/engine-golden-script.js but drives the SAME fixed
// timeline (same SEED, same 2-player roster, same buildTimeline ops, same DELTAS)
// through the PartyCore.frame() facade instead of Game directly. nowMs is a
// monotonic cumulative sum of the timeline's update deltas (all <= 50 so the
// MAX_FRAME_DELTA_MS cap never trips), so each 'update' op maps 1:1 to a frame()
// that applies exactly that op's delta.
//
// Clock priming: frame() always yields a 0 delta on its first call (no previous
// nowMs), so we prime once with frame(0) BEFORE the timeline. The prime frame
// also takes one snapshot (getState) right after init — see the reference below,
// which mirrors that exactly.
//
// Why NOT cross-validate against the committed engine-golden corpus: the engine
// golden deliberately NEVER calls getState()/getSnapshot(); it reads board.grid
// directly. But frame() MUST snapshot every frame (the value-copy is its whole
// point), exactly like the web renderLoop's per-frame getSnapshot(). getState()
// populates PlayerBoard's _ghostOf cache, which is keyed on col/row/rot/
// gridVersion but NOT piece type, so after a hold() (no gridVersion bump) a
// same-position cache hit can hand a wrong-typed ghost to a later hardDrop. That
// pre-existing engine subtlety makes the snapshot-every-frame execution (web,
// native, frame()) diverge from the no-snapshot engine golden from ~frame 25 on.
// So the faithful reference is a plain Game driven with the SAME deltas AND the
// SAME per-frame getSnapshot() cadence — isolating exactly what the facade adds
// (event buffering + value-copy + delta-capping) as behavior-preserving.

const { Game } = require('../../server/Game');
const { PartyCore } = require('../../server/PartyCore');
const { buildTimeline, hashGrid, SEED, PLAYER_IDS } = require('./engine-golden-script');

// FNV-1a 32-bit over the JSON serialization of an entire value-copy player —
// pins EVERY snapshot field, not just the grid. Snapshot data is pure ASCII
// (piece-type letters, numbers, booleans), so a per-char & 0xff mirrors hashGrid.
function hashJSON(x) {
  const s = JSON.stringify(x);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= (s.charCodeAt(i) & 0xff);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function clone(x) {
  return JSON.parse(JSON.stringify(x));
}

function newRoster() {
  return new Map(PLAYER_IDS.map((id) => [id, { startLevel: 1 }]));
}

// Drive a fresh PartyCore through the full timeline, invoking recordStep(deltaMs,
// frameResult, pc) on each 'update' op (i.e. each frame()). Inputs accumulate in
// the engine event buffer and surface at the next frame()'s drain — exactly the
// web's between-frame processInput accumulation. Garbage is injected via the same
// board.addPendingGarbage entry point the engine golden uses.
function drive(recordStep) {
  const pc = new PartyCore(newRoster(), SEED);
  pc.init();

  const timeline = buildTimeline();
  const steps = [];
  let nowMs = 0;
  pc.frame(nowMs); // prime the frame clock (0 delta, no engine advance; one snapshot)
  let postEnd = 0;

  for (const op of timeline) {
    if (op[0] === 'input') {
      pc.processInput(op[1], op[2]);
    } else if (op[0] === 'garbage') {
      const b = pc.game.boards.get(op[1]);
      if (b && b.alive) b.addPendingGarbage(op[2], op[3]);
    } else {
      nowMs += op[1];
      const f = pc.frame(nowMs);
      steps.push(recordStep(op[1], f, pc));
      // Match the engine golden's tail: record a few stable post-end frames.
      if (pc.game.ended && ++postEnd >= 5) break;
    }
  }

  return steps;
}

// The committed conformance corpus: per frame, the deltaMs applied, the drained
// events, the normalized commands, and — per board — a gridHash (used by the
// cross-validation test against the reference Game) plus a snapHash over the
// ENTIRE value-copy player (grid, currentPiece, ghost, holdPiece, nextPieces,
// level, lines, alive, pendingGarbage, clearingCells, gridVersion). The full
// snapHash makes a faithful value-copy load-bearing: corrupting ANY copied field
// (not just the grid — e.g. holdPiece, nextPieces, ghost) drifts the golden.
function runPartyCoreFrameScript() {
  const steps = drive((deltaMs, f) => ({
    deltaMs,
    events: f.events,
    commands: f.commands,
    boards: PLAYER_IDS.map((id) => {
      const p = f.snapshot.players.find((pl) => pl.id === id);
      return { id, gridHash: hashGrid(p.grid), snapHash: hashJSON(p) };
    }),
  }));
  return { seed: SEED, players: PLAYER_IDS.slice(), steps };
}

// Cross-validation source #1: per frame, the WRAPPED engine's full internal grid
// hash (incl. buffer rows) per board.
function runPartyCoreEngineHashes() {
  return drive((deltaMs, f, pc) =>
    PLAYER_IDS.map((id) => hashGrid(pc.game.boards.get(id).grid))
  );
}

// Cross-validation source #2: a plain Game driven with the SAME timeline AND the
// SAME per-frame getSnapshot() cadence frame() uses internally (one snapshot
// after init to mirror the prime, then one after each update). Records the
// buffered events, the full internal grid hash, and the live getSnapshot visible
// grid hash per board. frame()'s wrapped engine + drained events + value-copy
// visible grid must match this reference exactly.
function runReferenceGameSteps() {
  const buf = [];
  const game = new Game(newRoster(), {
    onEvent: (e) => buf.push(clone(e)),
    onGameEnd: (r) => buf.push(clone({ type: 'game_end', elapsed: r.elapsed, results: r.results })),
  }, SEED);
  game.init();
  game.getSnapshot(); // mirror PartyCore's prime-frame snapshot()

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
      const snap = game.getSnapshot();
      steps.push({
        events: buf.splice(0),
        engineHash: PLAYER_IDS.map((id) => hashGrid(game.boards.get(id).grid)),
        visibleHash: PLAYER_IDS.map((id) => hashGrid(snap.players.find((p) => p.id === id).grid)),
      });
      if (game.ended && ++postEnd >= 5) break;
    }
  }

  return steps;
}

module.exports = {
  runPartyCoreFrameScript,
  runPartyCoreEngineHashes,
  runReferenceGameSteps,
};
