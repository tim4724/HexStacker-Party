// Gameplay clip module — parameterized for calm (B), chaos (C), peak (D).
// Boots a deterministic local game in the display iframe and drives an AI
// loop per player, dispatching engine actions and the matching controller
// feedback animation in lockstep.

import { planNextPlacement, makeRng } from '../ai-player.js';

const NAMES = ['Emma', 'Jake', 'Sofia', 'Liam', 'Mia', 'Noah', 'Ava', 'Leo'];

// Style tiers (public/shared/theme.js): NORMAL ≤5, PILLOW 6-10, NEON_FLAT ≥11.
// Each gameplay beat sits squarely in one tier so the visual style step is
// obvious between cuts. prefillRows seeds each board with a non-completing
// pattern so the tier-specific block rendering reads immediately instead of
// needing several seconds of AI play to build a stack.
//
// Per-tier AI pacing — early tiers play deliberately (matches a casual
// player just learning the controls), higher tiers play faster (matches
// a player surviving the speed). Without this everyone tapped at ~120ms
// regardless of level, which felt machine-fast and unrealistic.
// Per-tier AI pacing — 4-player beats now read as casual play (longer
// "thinking" pauses + slower per-tap cadence). Chaos8p stays brisk
// because 8 simultaneous boards naturally fill the frame with motion.
// `startLines` seeds each board's LINES counter so the displayed level
// matches a realistic in-game progression instead of always reading 0.
// Engine convention: displayed level = floor(lines / 10) + startLevel, so
// the harness adjusts startLevel internally to keep the tier intact while
// the LINES badge shows a believable number for that level.
//
// `pace` is per-clip — heavier gravity needs faster AI dispatch so plans
// complete before pieces auto-lock; otherwise stacks grow and the
// feedback loop tanks one or two players (most visibly Jake at neon11).
const CLIPS = {
  normal4p: { players: 4, level:  2, durationMs: 7000, prefillRows: 4, startLines: 8,
              pace: { tapMin: 380, tapMax: 600, dropMin: 460, dropMax: 720 } },
  // Level 6 (low end of PILLOW tier): at level 8, gravity outpaced the
  // casual AI pace so all players KO'd ~4.5s in and the engine froze the
  // canvas on the results snapshot for the rest of the clip. Level 6 keeps
  // play going through the full 6 s while still showing the PILLOW style.
  pillow4p: { players: 4, level:  6, durationMs: 6000, prefillRows: 5, startLines: 52,
              pace: { tapMin: 280, tapMax: 460, dropMin: 360, dropMax: 540 } },
  // Pace ~2× slower than the previous half-speed tune. The original
  // (200-340/260-400) caused Jake-style runaway central piles because
  // ~40% of plans didn't finish before level-11 gravity (~133 ms per row)
  // auto-locked the piece. This middle point trades a bit of that risk
  // for visibly human-paced input — the previous 90-160/130-220 felt
  // machine-fast in playback even though it was behaviourally clean.
  neon4p:   { players: 4, level: 11, durationMs: 5500, prefillRows: 6, startLines: 105,
              pace: { tapMin: 180, tapMax: 320, dropMin: 240, dropMax: 380 } },
  chaos8p:  { players: 8, level:  6, durationMs: 7000, startLines: 47,
              // Three players start with a 4-row column-gap setup and an
              // I-piece queued first — the AI's heuristic scores vertical-I
              // into the well as a 4-line clear (linesCleared * 100 dominates),
              // so on the natural piece lock the engine fires real line_clear
              // events, GarbageManager picks lowest-stack opponents, garbage
              // indicators light up, and rows rise after GARBAGE_DELAY_MS.
              // Wave staggers ~500ms via the existing per-player nextActionAt
              // offset (200 + i*80), so the three quads land 0.7-1.2s in.
              clearSetups: [
                { playerIdx: 0, gapCol: 3 },
                { playerIdx: 3, gapCol: 5 },
                { playerIdx: 6, gapCol: 7 },
              ],
              prefillRows: 5,
              pace: { tapMin: 130, tapMax: 220, dropMin: 170, dropMax: 250 } },
};

// Stage the scene before recording starts: roster + game boot + prefilled
// stack. Composite calls this before signalling __AD_CLIP_READY__ so the
// screencast's first frame already shows the game (no welcome-screen flash
// at the cut between clips).
export async function stage({ display, clip, seed, playerCount }) {
  const cfg = CLIPS[clip] || CLIPS.chaos8p;
  const enginePlayers = cfg.players || playerCount;
  const playerInfo = rosterFor(enginePlayers, cfg);
  display.__TEST__.bootLocalGame({ playerInfo, seed, prefillRows: cfg.prefillRows });
  if (cfg.clearSetups) {
    for (const s of cfg.clearSetups) {
      display.__TEST__.primeForIClear(s.playerIdx, s.gapCol);
    }
  }
  // Freeze gravity until run() resumes — during the ~RAF + screencast-start +
  // GO-wait window between stage() and run(), the engine would otherwise tick
  // and let pieces (especially primed I-pieces in horizontal spawn orientation)
  // auto-lock above prefill before the AI can rotate/move them.
  if (display.displayGame) display.displayGame.pause();
}

export async function run({ display, controllers, clip, seed, playerCount }) {
  const cfg = CLIPS[clip] || CLIPS.chaos8p;
  const enginePlayers = cfg.players || playerCount;
  const playerInfo = rosterFor(enginePlayers, cfg);

  if (display.displayGame) display.displayGame.resume();
  const start = performance.now();
  // Per-player state: pending action queue + last-piece tracking so we only
  // re-plan when a new piece spawns.
  const ai = playerInfo.map((_, i) => ({
    queue: [],
    nextActionAt: start + 200 + i * 80,
    lastPiece: null,
    activeIdx: i < cfg.players,
    rng: makeRng((seed + i * 37) >>> 0),
    // First plan dispatches immediately so the clip's first visible frame
    // already shows motion. Subsequent plans wait the normal tap delay.
    // The xfade in multi-clip variants masks the start delay; on a
    // standalone clip 200-400ms of a static staged scene reads as a hang.
    firstPlan: true,
  }));

  await new Promise((resolve) => {
    function tick() {
      const now = performance.now();
      const elapsed = now - start;

      // End the clip the moment the engine leaves PLAYING — once any/all
      // players KO, displayGame transitions to RESULTS, the canvas paints
      // the static last snapshot, and the screencast emits identical
      // frames for the rest of the clip. Resolve early so capture.js
      // sizes the output to the actual gameplay duration.
      // 'playing' literal mirrors ROOM_STATE.PLAYING in shared/protocol.js;
      // we can't reach the constant across iframe boundaries cheaply, so
      // the string is intentional. If protocol's enum values ever change,
      // grep for ROOM_STATE.PLAYING to find this site.
      if (display.roomState && display.roomState !== 'playing') {
        resolve();
        return;
      }

      for (let i = 0; i < ai.length; i++) {
        const slot = ai[i];
        if (!slot.activeIdx) continue;

        const game = display.displayGame;
        const id = display.playerOrder && display.playerOrder[i];
        const board = game && id ? game.boards.get(id) : null;
        if (!board || !board.alive || !board.currentPiece) {
          slot.queue.length = 0;
          continue;
        }

        // Detect new piece — board.currentPiece is replaced on lock+spawn.
        if (board.currentPiece !== slot.lastPiece) {
          slot.queue.length = 0;
          const plan = planNextPlacement(display, i, slot.rng, cfg.pace);
          // planNextPlacement restores via cloned reference, so re-anchor
          // lastPiece to whatever the board now points at.
          slot.lastPiece = board.currentPiece;
          if (plan) {
            slot.queue = plan;
            slot.nextActionAt = slot.firstPlan ? now : now + plan[0].delayMs;
            slot.firstPlan = false;
          }
        }

        if (slot.queue.length > 0 && now >= slot.nextActionAt) {
          const step = slot.queue.shift();
          const ctrl = controllers[i];
          if (step.action === 'swipeLeft' || step.action === 'swipeRight') {
            // Engine receives one move per column the swipe traverses, but
            // the controller fires a SINGLE swipe feedback covering the
            // whole gesture distance. ~80ms between engine moves matches
            // the swipe-glow cadence so the piece visibly travels col-by-
            // col instead of teleporting; was 28ms which read as an instant
            // multi-col jump that didn't match the lingering glow.
            const move = step.action === 'swipeLeft' ? 'moveLeft' : 'moveRight';
            for (let s = 0; s < step.count; s++) {
              setTimeout(() => display.__TEST__.applyMove(i, move), s * 80);
            }
            ctrl.__TEST__.showFeedback(step.action, { count: step.count });
          } else {
            display.__TEST__.applyMove(i, step.action);
            ctrl.__TEST__.showFeedback(step.action);
          }
          if (slot.queue.length > 0) {
            slot.nextActionAt = now + slot.queue[0].delayMs;
          }
        }
      }

      if (elapsed < cfg.durationMs) {
        requestAnimationFrame(tick);
      } else {
        resolve();
      }
    }
    requestAnimationFrame(tick);
  });
}

// Build a roster of n players from a tier config. `levels` / `startLines`
// can be arrays for per-player values; otherwise the singular forms apply
// uniformly. The harness uses `startLines` to seed each board's LINES
// counter and back-computes startLevel so the displayed level matches.
function rosterFor(n, cfg) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const level = Array.isArray(cfg.levels) ? cfg.levels[i] : cfg.level;
    const startLines = Array.isArray(cfg.startLines)
      ? (cfg.startLines[i] || 0)
      : (cfg.startLines || 0);
    out.push({ id: `adclip-p${i}`, name: NAMES[i] || `P${i + 1}`, slot: i, level, startLines });
  }
  return out;
}
