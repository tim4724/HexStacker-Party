# Display-Core Refactor Plan (revised)

Single-source the platform-agnostic display logic so web, tvOS, and a future
Android TV app run the *same* tested JS, and the parity bugs in the native ports
get fixed by construction instead of re-typed per platform. This plan covers the
**foundation that lands on `main`**; native consumers are deferred to their own
branches.

> **Revision note.** This supersedes the first draft. Five things changed after
> grounding the plan in the code:
> 1. The three input rules are **split by their true nature**, not bundled as
>    "board mechanics." Soft-drop auto-end + hard-drop-supersedes-soft-drop go
>    into `PlayerBoard` (real board state/rules). The 150 ms hard-drop
>    rate-limit does **not** — it is transport-reconnect debounce, so it lives
>    in `Game`'s input layer, never in board state.
> 2. The **characterization corpus moves first** (before the engine mutation),
>    because there is **no** `ParityCheck`/golden net on `main` today (it is
>    Swift-only, in the apple-tv tree). Refactoring first = working without a net.
> 3. **No new `DisconnectPolicy` reducer.** `partyplug/RoomFlow.js` already owns
>    presence + host election; the liveness decisions fold **into RoomFlow** to
>    avoid a third presence store.
> 4. The shared substrate **stays at `server/*.js`** (already UMD, already loaded
>    by web + JSC). The `public/shared/core/` move is optional/deferred; the
>    purity gate applies to `server/`.
> 5. Native framing is corrected: the Swift bridge is **already pull-only**, so
>    `frame()` is a convenience, not a rewrite. The real re-type cost is the
>    display brain, tracked as a later, scoped step — not oversold here.

## 1. Goal & non-goals

**Goal.** Move the *timer/decision* logic from per-platform glue into the shared,
deterministic, clock-free engine substrate (the JS that already runs in Node, the
browser, and JavaScriptCore; QuickJS on Android), so it is written once, tested
once, and cannot drift between platforms.

**Non-goals (stay native, forever):** transport (WebSocket + WebRTC), rendering
(canvas vs SpriteKit), audio synthesis, platform services (wakeLock, QR,
clipboard, AirConsole SDK). The boundary ends at `snapshot + events + commands`:
shared code emits data, native draws/sends it.

## 2. The reuse boundary

The engine (`server/*.js`: `Game` + `PlayerBoard` + `GarbageManager` + friends)
is already deterministic, seeded, clock-free, and `deltaMs`-driven (`grep` of
`server/` for `Date.now|setTimeout|setInterval|fetch|WebSocket|document` is
empty; time enters only as `deltaMs` into `Game.update`/`PlayerBoard.tick`). It
already runs byte-identically in Node and the browser, and is the substrate the
native ports load. That makes it the correct home for any genuinely
platform-agnostic *decision* logic.

The three input rules, split by nature:

| Rule | Today (web glue; absent on tvOS) | After |
| --- | --- | --- |
| Soft-drop auto-end (300 ms) | `setTimeout(endSoftDrop, 300)` `DisplayInput.js:267` | `PlayerBoard.softDropDeadlineMs`, armed in `softDropStart`, decremented in `tick(deltaMs)`, auto-ends at ≤ 0 |
| Hard-drop supersedes soft-drop | `endSoftDrop()` before `processInput` `DisplayInput.js:251` | `PlayerBoard.hardDrop()` calls `softDropEnd()` internally |
| Hard-drop rate-limit (150 ms) | `lastHardDropTime` wall-clock map `DisplayInput.js:244-248` | **`Game` input layer**: per-player cooldown map, gated in `Game.processInput('hard_drop')`, decremented in `Game.update(deltaMs)` |

**Why the cooldown stays out of `PlayerBoard`:**
- It is **transport debounce** (its job is absorbing relay reconnect message
  bursts — `DisplayInput.js:11,243`), not physics. It is meaningless/wrong for
  AirConsole and native transports with different burst characteristics, so it
  belongs at the input boundary, where each platform feeds the engine.
- Putting it in `board.hardDrop()` would make that primitive **non-idempotent**
  (result depends on accumulated cooldown), destroying the pure
  `(state, action) → state` property the corpus and future reducers need.
- It would **break the suite**: every `hardDrop` test calls `b.hardDrop()`
  directly in tight loops with no `tick()` between (`gameplay-integration`,
  `hex-board`); a board-level cooldown returns `null` after the first.
- Gating in `Game.processInput` is safe: all `hardDrop` tests bypass it
  (direct board calls), and no test drives `processInput('hard_drop')` in a loop.
  The gallery's `DisplayTestHarness.applyMove('hardDrop')` also calls
  `board.hardDrop()` directly, so seeded captures stay frame-identical.

**Soft-drop auto-end and supersede *are* board state.** `softDropping` /
`softDropSpeed` already live on `PlayerBoard` (`:47-48,155-168`);
`softDropDeadlineMs` is a direct sibling of the existing decremented
ms-countdowns (`lockTimer :277-282`, `clearingTimer :227-233`,
`GarbageManager.msLeft :58-74`). Moving supersede into `hardDrop()` also **fixes
a latent bug**: today only `DisplayInput` applies it, so the gallery's direct
`board.hardDrop()` path and the tvOS kit silently skip it.

### Liveness / disconnect → extend `RoomFlow`, do not add a new reducer

`partyplug/RoomFlow.js` is already a pure reducer owning presence
(`_disconnected`), host election (with `prevHost !== host` dedup), and roster,
with unit coverage. The web already hand-syncs two presence stores
(`disconnectedQRs` ↔ `flow._disconnected`). A new `DisconnectPolicy` would make
three. Instead, fold the remaining **decisions** (all-disconnected auto-pause,
late-joiner grace → return to lobby, AirConsole-mode liveness no-op via a `mode`
flag) **into RoomFlow**, returning typed results. Effects (overlays, QR,
`reconnectNow`, music ducking, heartbeat send) stay native. This is a later
step (see §5), not part of the first landing.

## 3. Invariants (enforced by a CI gate)

1. **Pull-only.** Shared code never invokes a host callback; native pulls
   command/event arrays. (The engine's `onEvent` callback is the one existing
   exception; the `frame()` facade in §5 returns events as a drained array so
   native marshals values, not callbacks.)
2. **Deadlines, not timers.** No `setTimeout`/`setInterval`; time is injected as
   `deltaMs`.
3. **No I/O, no DOM, no wall-clock.** Non-determinism (seed, mode, join URL)
   passed in as params. (`Math.random()` is permitted only for the default seed
   in `Game`'s constructor.)
4. **One frame call (target).** Native can drive everything through a single
   `frame(nowMs) → { state, events, snapshot }` (see §5), while
   `update`/`snapshot`/`drainEvents` stay individually callable.
5. **CI grep gate** fails the build on
   `Date.now|setTimeout|setInterval|fetch|WebSocket|document` under `server/`.

## 4. The shared interface (this milestone)

**Engine additions:**
- `PlayerBoard.softDropDeadlineMs` — armed (set to `SOFT_DROP_TIMEOUT_MS`) in
  `softDropStart` on every call (re-arm), decremented in `tick(deltaMs)` before
  the gravity computation, auto-calls `softDropEnd()` at ≤ 0. Re-arm writes the
  field directly; it must not re-trigger `softDropStart`'s `gravityCounter`
  reset (already guarded to OFF→ON), or accelerated fall stalls.
- `PlayerBoard.hardDrop()` — calls `this.softDropEnd()` first (supersede).
- `Game` per-player hard-drop cooldown — a `Map` keyed by `playerId`;
  `processInput('hard_drop')` returns early (silent, matching today) while
  cooldown > 0, else sets it to `HARD_DROP_MIN_INTERVAL_MS`; `update(deltaMs)`
  decrements every entry. `PlayerBoard` is untouched by this.

```js
// PlayerBoard.softDropStart(speed):  ...existing guard... this.softDropDeadlineMs = SOFT_DROP_TIMEOUT_MS;
// PlayerBoard.tick(deltaMs): (before gravity)
if (this.softDropping) {
  this.softDropDeadlineMs -= deltaMs;
  if (this.softDropDeadlineMs <= 0) this.softDropEnd();
}
// PlayerBoard.hardDrop(): this.softDropEnd();  // then existing drop+lock
// Game.processInput('hard_drop'): if ((this._hardDropCd.get(playerId) || 0) > 0) return;
//                                 this._hardDropCd.set(playerId, HARD_DROP_MIN_INTERVAL_MS);
// Game.update(deltaMs): for (const [id, ms] of this._hardDropCd) this._hardDropCd.set(id, Math.max(0, ms - deltaMs));
```

## 5. Migration steps

Each step is shippable and gated. Milestone 1 (Steps 0–3) is the first PR; it
closes the three input gaps on every platform with a real net under it.

- **Step 0 — Constants (XS).** Move `HARD_DROP_MIN_INTERVAL_MS` (and
  `LATE_JOINER_GRACE_MS`, for the later RoomFlow step) into `server/constants.js`
  with their `exports.` lines. `SOFT_DROP_TIMEOUT_MS` already lives there. Add a
  finite-number assertion so a missing export can't silently disable the gate.
- **Step 1 — Characterization net (M, first).** Build a golden harness: fixed
  seed + scripted `(deltaMs, input)` timeline → serialized board-state stream +
  event stream → committed golden JSON, with a replay test. Record goldens for
  general gameplay (gravity, lock, line clear, garbage, rotation) that do **not**
  exercise the new soft-drop-auto-end/cooldown edges, so they prove the Step-2
  move is behavior-preserving for everything else. Add the purity grep gate over
  `server/` (passes today; trips if a `setTimeout` is moved in naively). Decide
  exact-hash vs tolerance up front (`frames = deltaMs/(1000/60)` is exact only on
  identical `deltaMs` streams).
- **Step 2 — Engine move (M, strangler).** Implement the soft-drop deadline +
  supersede in `PlayerBoard` and the cooldown in `Game`. Add targeted tests:
  lost-SOFT_DROP_END recovers via auto-end, re-arm extends the deadline,
  hard-drop clears soft-drop, rapid `processInput('hard_drop')` is throttled,
  cooldown decrements over `update`. Goldens stay green.
- **Step 3 — Remove web glue (M).** Delete the now-redundant `DisplayInput.js`
  timing glue (`lastHardDropTime`, `softDropTimers`, the `setTimeout`, the
  rate-limit + supersede block). Keep the `handleSoftDropStart/End` /
  `processInput` calls and the disconnect/rekey → end-soft-drop behavior
  (`cleanupPlayerInput`). Behavior unchanged on web; full suite green.

**Deferred to follow-up PRs on `main`:**
- **Step 4 — RoomFlow liveness extension** (fold the disconnect decisions in;
  collapse `disconnectedQRs` into a render-derived view).
- **Step 5 — `frame()` facade** (§ below), value-copy snapshot, drained events.
- **Optional — directory move** `server/*` → `public/shared/core/`, done
  consumer-atomically (CSP allowlist, `index.html` script tags, apple-tv
  `sync-engine.sh` load order, `EngineCheck` path) in its own PR.

## 6. The ideal native-reuse interface (define now, implement in Step 5)

```
PartyCore.init(config) -> State
PartyCore.frame(state, commands, nowMs) -> { state, events, snapshot }
```

- `commands`: serializable intents this frame —
  `{ clientId, kind: 'input'|'softDropStart'|'softDropEnd'|'connect'|'disconnect'|'pause'|'resume', ... }`.
- **Clock normalization lives inside `frame()`**: it caps `nowMs → deltaMs`
  (move `MAX_FRAME_DELTA_MS = 50` in from `DisplayRender.js:9,49`) and applies the
  pause/not-playing gate, so a 120 Hz tvOS host and a 60 Hz Android host behave
  identically.
- Internally runs the input-timing (cooldown + soft-drop-end synthesis), the
  engine tick, and the RoomFlow liveness decision.
- Returns `events` as a plain serializable array, `snapshot` as a **value copy**
  (not the live mutable references `getSnapshot()` returns today), and host
  effects as a `commands`/effects list (send-to-controller, playerDead,
  gameOver, beep, vibrate, music cue) — the highest-value extraction, since the
  Swift `DisplayCoordinator.applyEvents` re-types exactly this.
- Keep `update()`/`snapshot()`/`drainEvents()` separately callable — native
  ticks at vsync but snapshots only on `gridVersion` change.

## 7. Honest scope note

Milestone 1 fixes **three** silent tvOS parity bugs (infinite soft-drop on lost
END, reconnect double-drop, soft-speed bleed — all absent from the Swift kit
today) and lays the corpus + purity gate. That is real and worth shipping on its
own. It is **not** "ports become cheap": the bulk of the native re-type cost is
the ~600-line display brain (countdown FSM, lobby/welcome payloads, results
enrichment, event→host-command translation), addressed only when Step 5 extracts
it behind `frame()`'s `commands`. We do not oversell this milestone as more than
it is.
