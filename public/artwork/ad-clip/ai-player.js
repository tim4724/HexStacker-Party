// Hex-aware AI placement search for ad-clip gameplay.
//
// Approach: mutate-test-restore the live PlayerBoard for each candidate
// rotation × column, score the resulting grid, then restore. The engine
// does not advance gravity inside this synchronous search, so a single
// frame budget is more than enough for 11 cols × 4 rotations.
//
// Returned plan: a list of {action, delayMs} steps the gameplay-clip
// orchestrator dispatches via display.__TEST__.applyMove and the matching
// controller.__TEST__.showFeedback, in lockstep.

const ROTATIONS = 4;

export function planNextPlacement(displayWindow, playerIdx, rng, opts) {
  opts = opts || {};
  const tapMin = opts.tapMin != null ? opts.tapMin : 90;
  const tapMax = opts.tapMax != null ? opts.tapMax : 160;
  const dropMin = opts.dropMin != null ? opts.dropMin : 120;
  const dropMax = opts.dropMax != null ? opts.dropMax : 200;

  const game = displayWindow.displayGame;
  if (!game) return null;
  const id = displayWindow.playerOrder[playerIdx];
  if (!id) return null;
  const board = game.boards.get(id);
  if (!board || !board.alive || !board.currentPiece) return null;

  const HEX_COLS = displayWindow.GameConstants.COLS;
  const TOTAL_ROWS = displayWindow.GameConstants.TOTAL_ROWS;
  const BUFFER_ROWS = displayWindow.GameConstants.BUFFER_ROWS;
  const findClearableZigzags = displayWindow.GameConstants.findClearableZigzags;

  // Snapshot for restoration.
  const snap = {
    piece: board.currentPiece.clone(),
    pieceRef: board.currentPiece
  };

  let best = { score: -Infinity, rotations: 0, lateral: 0 };

  for (let rot = 0; rot < ROTATIONS; rot++) {
    if (rot > 0) {
      // Rotate live piece (real wall-kicks). On failure, skip remaining rots.
      if (!board.rotateCW()) break;
    }
    // Snapshot the rotation's start col so we can compute lateral deltas.
    const baseCol = board.currentPiece.anchorCol;
    const baseRot = board.currentPiece._rotId;

    for (let targetCol = 0; targetCol < HEX_COLS; targetCol++) {
      const dir = targetCol > baseCol ? 1 : (targetCol < baseCol ? -1 : 0);
      const distance = Math.abs(targetCol - baseCol);
      let lateralDone = 0;
      let blocked = false;
      for (let s = 0; s < distance; s++) {
        const ok = dir > 0 ? board.moveRight() : board.moveLeft();
        if (!ok) { blocked = true; break; }
        lateralDone++;
      }
      if (!blocked) {
        const ghost = board._ghostOf(board.currentPiece);
        const score = scoreGrid(board, ghost, HEX_COLS, TOTAL_ROWS, BUFFER_ROWS, findClearableZigzags);
        if (score > best.score) {
          best = { score, rotations: rot, lateral: targetCol - baseCol };
        }
      }
      // Undo lateral. Re-snap rotation to baseRot if a kick somehow drifted it.
      for (let u = 0; u < lateralDone; u++) {
        if (dir > 0) board.moveLeft(); else board.moveRight();
      }
      if (board.currentPiece._rotId !== baseRot) break;
    }
  }

  // Restore original piece. _cachedGhost/_ghostKeyRot are private fields on
  // PlayerBoard and the search mutated state behind them — keep these names
  // in sync if PlayerBoard's ghost cache is ever renamed or reshaped.
  board.currentPiece = snap.piece;
  board._cachedGhost = null;
  board._ghostKeyRot = -1;

  // Build action plan: rotations as discrete taps; lateral movement as a
  // single swipe gesture (one feedback animation regardless of how many
  // columns it crosses); then hard drop.
  const plan = [];
  const tap = () => randInt(rng, tapMin, tapMax);
  for (let r = 0; r < best.rotations; r++) {
    plan.push({ action: 'rotateCW', delayMs: tap() });
  }
  const lateralCount = Math.abs(best.lateral);
  if (lateralCount > 0) {
    plan.push({
      action: best.lateral > 0 ? 'swipeRight' : 'swipeLeft',
      count: lateralCount,
      delayMs: tap(),
    });
  }
  plan.push({ action: 'hardDrop', delayMs: randInt(rng, dropMin, dropMax) });
  return plan;
}

function scoreGrid(board, ghost, COLS, TOTAL_ROWS, BUFFER_ROWS, findClearableZigzags) {
  // Hypothetical post-lock grid. Clone columns we touch only.
  const ghostBlocks = ghost.getAbsoluteBlocks();
  const writes = [];
  for (let i = 0; i < ghostBlocks.length; i++) {
    const c = ghostBlocks[i][0], r = ghostBlocks[i][1];
    if (r >= 0 && r < TOTAL_ROWS && c >= 0 && c < COLS) {
      writes.push([c, r, board.grid[r][c]]);
      board.grid[r][c] = ghost.typeId || 1;
    }
  }

  // Lines cleared by this placement.
  const result = findClearableZigzags(COLS, TOTAL_ROWS, function(col, row) {
    return board.grid[row][col] !== 0;
  }, null, BUFFER_ROWS);
  const linesCleared = result.linesCleared;

  // Heights & holes per column.
  const colTops = new Array(COLS).fill(TOTAL_ROWS);
  for (let c = 0; c < COLS; c++) {
    for (let r = BUFFER_ROWS; r < TOTAL_ROWS; r++) {
      if (board.grid[r][c] !== 0) { colTops[c] = r; break; }
    }
  }
  let totalHoles = 0;
  let maxHeight = 0;
  let bumpiness = 0;
  for (let c = 0; c < COLS; c++) {
    const h = TOTAL_ROWS - colTops[c];
    if (h > maxHeight) maxHeight = h;
    if (c > 0) bumpiness += Math.abs(h - (TOTAL_ROWS - colTops[c - 1]));
    for (let r = colTops[c] + 1; r < TOTAL_ROWS; r++) {
      if (board.grid[r][c] === 0) totalHoles++;
    }
  }

  // Restore mutations.
  for (let i = writes.length - 1; i >= 0; i--) {
    board.grid[writes[i][1]][writes[i][0]] = writes[i][2];
  }

  return linesCleared * 100 - totalHoles * 30 - maxHeight * 5 - bumpiness * 3;
}

function randInt(rng, lo, hi) {
  return Math.floor(rng() * (hi - lo + 1)) + lo;
}

// Tiny seeded PRNG so action delays are deterministic per capture.
export function makeRng(seed) {
  let s = seed >>> 0;
  return function() {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
