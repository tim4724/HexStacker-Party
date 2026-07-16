# HexStacker tvOS — Status

What is built, what is proven, and what still needs Xcode / a real device.

## Verified on macOS (Command Line Tools only)

The entire platform-agnostic core lives in `HexStackerKit` and is proven by the
`swift test` suite, which runs under Command Line Tools (swift-testing ships with
the toolchain, so no full Xcode is required).

| Area | What it does | Proof |
| --- | --- | --- |
| **Engine bridge** (`Engine/`) | Drives the canonical `server/*.js` in JavaScriptCore through the `PartyCore.frame()` facade; typed Codable snapshots/events/commands | Loads real engine; spawn/hard-drop/hold; **frame() events+snapshot+commands** mapping; **determinism** (same seed+inputs → byte-identical snapshot + event stream); seed sensitivity |
| **Transport** (`Net/RelayClient`) | Party-Server WebSocket: create/join, send/broadcast, reconnect+backoff, instance pinning, 1 Hz self-heartbeat | `RelayClientLiveTests`: the real client over a loopback WebSocket (in-process mock relay) — create/join handshake, inbound frame decode + dispatch, outbound envelope shape, auto-reconnect with clientId re-join (production relay still exercised in-app) |
| **Room/host FSM** (`Net/RoomFlow`) | Roster, sticky host, three-tier election, valid transitions | First-joiner host, mid-game pin + reclaim, lobby promotion, invalid-transition rejection |
| **Geometry** (`Render/BoardGeometry`) | Flat-top hex math, column-parity stagger, multi-board layout | boardWidth=9·cell, stagger=½hexH, row pitch=hexH, layout buckets |
| **Theme/color** (`Render/Theme`) | Palettes, style tiers, lighten/darken/ghost/luminance | Exact values match the canvas utils |
| **Coordinator** (`Game/DisplayCoordinator`) | The display brain: relay+room+engine, lifecycle | **Full headless run**: connect → lobby → hello/welcome → start → countdown(3·2·1·GO) → engine play → single-player top-out → results → play-again |

### Cross-engine parity (the "do both renderers look the same" guarantee)

`ParityTests` loads the **real web render math** (server/constants.js
`computeHexGeometry` + `findClearableZigzags` + `findNearClearZigzags`,
public/shared/theme.js palettes + `getStyleTier`, CanvasUtils.js
`lighten`/`darken`/`ghostColor`) in JavaScriptCore and asserts the native Swift
ports (`HexGeometry` / `Theme` / `ColorMath` / `Zigzag`) are **byte-identical**:
board geometry, every cell center, all piece + player colors, style tiers, color
utilities, and the zigzag clear-detection used for the on-board clear preview and
near-clear pulse (including the bottom-first overlap ordering and the
ghost-completion filter). Because both renderers draw the same engine snapshots,
identical geometry + colors + detection means each engine places the same
colored hex — and the same feedback highlight — in the same cell.

Run it:

```bash
cd appletv
swift build   # builds the kit
swift test    # full verification: engine determinism, render parity, netcode, room/host, live relay socket
```

The tvOS app itself was also **built and run in the tvOS Simulator** (verified by
screenshot): lobby + live relay room, then a 2-board game rendering falling
pieces, ghost, locked stack, the full HUD (HOLD/NEXT/LEVEL/LINES + garbage
meter), and animations (lock flash, line-clear popup/confetti, KO, shake).

## tvOS app: builds, links, and runs in the tvOS Simulator

`Sources/HexStackerTV/` is the tvOS app. It is **not** part of the SwiftPM
package (it imports UIKit/SpriteKit/AVFoundation/SwiftUI), so it compiles only
through the Xcode project / tvOS SDK.

**Verified:** the whole app **builds and links against the tvOS 26.5 Simulator
SDK** (`xcodebuild -sdk appletvsimulator`, arm64, LiveKitWebRTC linked) and
**runs in the Apple TV 4K Simulator** — the lobby, live game, countdown, and
results screens were all rendered and screenshotted, and the `HEXDEMO` self-play
loop ran continuously without crashing. Guarded in CI by the `tvos-app` job.
Modules:

- **`HexStampFactory`** — Core Graphics hex stamps for all three tiers (NORMAL gradient+bands, PILLOW rounded+gloss, NEON_FLAT dark+rim), cached as SKTextures.
- **`BoardNode`** — one board from a snapshot: baked well+grid background, locked stack (cached by `gridVersion`), live piece + ghost, name/stats labels. Handles the canvas-Y-down → SpriteKit-Y-up flip.
- **`BoardScene`** — the SpriteKit remainder after the SwiftUI chrome migration: per-player game boards + match timer + the lobby's falling-piece background; stays the per-frame pump (`update(_:)` → coordinator tick).
- **`DisplayModel`** — the shell: owns `RelayClient` + `DisplayCoordinator` + `MusicPlayer` + `BoardScene`, implements `DisplayOutput` by folding chrome callbacks into a published `UiModel` (mirrors Android's `TvDisplayOutput` + `MainActivity` wiring).
- **`DisplayRootView` + SwiftUI chrome** (`LobbyView`, `ResultsView`, `AboutView`/`LicensesListView`+`LicenseTextView`, pause/countdown/connection overlays) — composites the chrome above the `SpriteView`, Android `DisplayChrome` parity.
- **`MusicPlayer`** — AVAudioEngine looping music at 0.50 volume with constant-pitch tempo scaling (0.95→1.35 by level), plus synthesized square-wave countdown beeps.
- **`QRCode`** — `CIQRCodeGenerator` at EC level L for the join URL.
- **`App` / `PressHostController`** — SwiftUI entry behind a UIKit root shim that owns the remote's focus-independent presses (Play/Pause, Menu), audio session setup.

## Required manual steps in Xcode

1. `brew install xcodegen && cd appletv && xcodegen generate` (the pre-build
   phase copies the engine JS + music into the bundle automatically). Done.
2. **Install the tvOS Simulator runtime**: Xcode > Settings > Components (or
   `xcodebuild -downloadPlatform tvOS`). Only the device SDK is installed now, so
   the Simulator destination is unavailable until you add the runtime. After
   that, `Run` against an Apple TV Simulator.
3. **Pick a signing Team for device / archive builds.** No `DEVELOPMENT_TEAM` /
   `CODE_SIGN_STYLE` is committed (it is developer-specific), so the Simulator
   runs as-is, but a real device or a TestFlight / App Store archive needs a Team
   selected under target → Signing & Capabilities, the
   `com.hexstacker.HexStackerTV` bundle ID registered in the Developer portal,
   and a matching App Store Connect record.

Done (no longer manual): the **Orbitron TTF** ships at
`Sources/HexStackerTV/Resources/fonts/Orbitron[wght].ttf`, wired via
`project.yml` → `UIAppFonts`; the **"App Icon & Top Shelf Image" brand-assets
catalog** is complete and now carries the real HexStacker brand art (colorful
hex pieces + gradient wordmark on plum, layered for parallax). Regenerate the
brand art with `node artwork/generate-tvos-icons.js` (app icon) and
`node artwork/generate-tvos-topshelf.js` (Top Shelf images).

## Deliberate v1 scope cuts (documented, not bugs)

- Per-frame board rebuild is naive (rebuilds piece/ghost nodes each frame; locked
  cells cached by `gridVersion`). Fine for ≤8 small boards; pool nodes if needed.
- No animated welcome/trailer screen (the display auto-creates a room and goes
  straight to the lobby; the lobby carries the brand + falling-piece background).

### WebRTC input fastlane

Native port of the receiver half of `partyplug/PartyFastlane.js`: controller input
rides peer-to-peer WebRTC DataChannels when open, with the relay carrying SDP/ICE
signaling and serving as the always-available fallback (every display → controller
message still goes over the relay). The display is relay slot 0 and is receive-only
— controllers create the unreliable/unordered channel and offer on join; the display
auto-accepts, trickles ICE, dedupes input by implicit per-event seq, and replies with
cumulative acks. A 3 s inbound-silence watchdog tears a dead peer down so it falls back
to the relay. Two layers:

- **`HexStackerKit/Net/Fastlane.swift`** — the platform-agnostic netcode (wire codec,
  dedup, acks, stats, watchdog) behind the `InputFastlane` protocol. No WebRTC import,
  so it builds and is **verified under Command Line Tools** by `FastlaneTests`
  (mirroring the receiver cases in `party-fastlane.test.js`) plus a
  coordinator-integration test in `DisplayCoordinatorTests` (signal interception,
  input routed through the one handler, peer close on leave) — all via `swift test`.
- **`HexStackerTV/WebRTCFastlane.swift`** — the WebRTC transport (one `RTCPeerConnection`
  per controller, perfect-negotiation accept path, ICE, the DataChannel), gated on
  `#if canImport(LiveKitWebRTC)`. It drives the netcode above.

**Verification.** The `LiveKitWebRTC` package (pinned in `project.yml`) is LiveKit's
WebRTC distribution — the binary that ships tvOS slices (stasel/WebRTC is iOS/macOS
only). The whole app, with the adapter compiled (`canImport` true) and the framework
linked, **builds for the Apple TV Simulator** (`xcodebuild ... -sdk appletvsimulator`)
and was **launched in the tvOS 26.5 Simulator**: it loads the framework, initializes
WebRTC (SSL + peer-connection factory) without crashing, connects to the live relay,
creates a room, and renders the lobby. Removing the package makes `canImport` false and
the app falls back to relay-only input — the kit + netcode still build and pass
`swift test` under Command Line Tools. The one thing not yet exercised is a
real controller completing the P2P handshake (needs a phone): open a phone controller to
the room QR and watch the controller's fastlane bolt light up while input still works
(the relay fallback is always live).

### Localization + full-parity round

- **Localization (12-ish locales).** The display reads the device language and
  renders every string localized (en, de, fr, pt, es, zh, ja, ko, ru, it, tr)
  via platform localization: `Localizable.xcstrings` in the app target, the
  committed mirror of `public/shared/i18n.js`, kept in lockstep by
  `tests/i18n-appletv-parity.test.js` (same guard as the Android
  `res/values-*/strings.xml`). Foundation owns locale matching, EN fallback, and
  CLDR plural selection (incl. Russian one/few/many and CJK other-only); the
  thin `tr()`/`trUpper()` shims live in `HexStackerTV/Strings.swift`. Because
  the localizations are declared in the bundle, the App Store lists all
  languages and tvOS offers a per-app language setting. The web copy stays the
  single source of truth, so the TV cannot drift from it.
- **Resilience parity with the web display:**
  - All-participants-disconnected → **silent auto-pause** (no overlay/broadcast),
    a 5 s **late-joiner grace** that returns to the lobby, and **auto-resume** when
    a controller returns (`RoomFlow` liveness/grace ported from the JS source).
  - **Per-controller silent-peer timeout** (3 s) → the per-board rejoin QR.
  - **Cross-device mid-game rejoin** (`?claim=`): re-keys the kept slot + the engine
    board/garbage/cooldown onto the returning peer (`Game.rekeyPlayer`).
  - **Host hand-off** mid-game is re-broadcast so the new host's phone gains controls.
  - **Relay-link drop freezes the sim** (no blind KOs behind the reconnect overlay);
    reconnect resumes. Reconnect overlay shows live **"Attempt N of M"**.
  - **App background suspends the relay socket** (no room teardown:
    backgrounding is recoverable, unlike the web's pagehide close_room) so
    controllers see peer_left(0) and wait on their reconnect overlay;
    foreground rejoins slot 0 and re-welcomes, or opens a fresh room if the
    relay retired it.
    **Eviction** (slot stolen) shows a terminal disconnect with no reconnect
    (avoids a takeover war).
  - Host **mute from the phone** now silences live TV music immediately.
- **Visual polish:** attacker-colored incoming-garbage telegraph + white
  defence/cancel flash on the meter; KO white-flash + 12-particle burst;
  lock-flash only from exposed bottom-edge blocks; 8 lobby placeholder slots
  (4K-wide branch).
- **Architecture refinements** (from a multi-agent audit): EngineBridge now drains
  the JS exception box after every call (a stale exception no longer poisons the
  next `frame()`); `output` is weak (no RootScene↔coordinator retain cycle);
  RelayClient invalidates its URLSession on teardown; boards rebuild on the
  player-id SET (not just count), fixing stale boards on a same-size new roster;
  outbound dicts omit nil keys instead of `as Any`; engine errors are surfaced.

### Review + hardening round (parity gaps closed)

A three-way audit (web↔tvOS render parity, web↔tvOS behavior parity, Swift
bug/perf review) drove this round. Every fix below is backed by a unit test or a
build.

- **Reconnect state resync (was player-visible breakage).** The `WELCOME` sent on
  a controller (re)connect now carries the participant's real `alive` state
  (`false` once KO'd) and, on the results screen, the finished `results` payload —
  mirroring the web's `lastAliveState`/`lastResults`. Before, a KO'd phone that
  reconnected (or any phone during a display relay-blip re-welcome) was told
  `alive:true` and flipped back to the live playing UI, and a phone landing on
  results saw a blank screen. KO state is carried across a `?claim=` rejoin and
  reset on a new match. (`DisplayCoordinatorTests` covers both.)
- **Display relay-reconnect roster reconciliation.** `onJoined` now routes each
  peer the relay no longer lists through the state-aware `onPeerLeft` (web
  `onDisplayRejoined`) instead of a blanket `markDisconnected`: lobby ghosts are
  removed (no inflated "Start (N)"), and a dropped mid-game board raises its
  rejoin QR instead of silently softlocking (a `markDisconnected` peer is skipped
  by the liveness sweep forever, so it never self-healed).
- **Fatal relay-error recovery.** A relay `error` of "Room not found"/"Room is
  full" on a reconnect now tears down and opens a fresh room (web
  `resetToWelcome`), landing back on the lobby, instead of getting stuck on a dead
  room. New `RelayClient.recreateRoom()` + coordinator handler.
- **Defensive parity:** a Play-Again that races the presence sweep to zero
  participants bounces back to the lobby instead of building a zero-player engine;
  a departing player's soft-drop is ended on leave (web `cleanupPlayerInput`).
- **RelayClient retain cycle removed.** The URLSession delegate is now a
  weak-forwarding proxy, so the session no longer strongly retains the client and
  `deinit` (which invalidates the session) is reachable — previously the only
  teardown path (`disconnect()`) was never called, so the client + its heartbeat/
  reconnect timers would leak the moment anything recreated the scene.
- **Render fidelity:** the baked grid mesh is composited once at `gridAlpha` via a
  transparency layer (shared cell edges were being stroked twice, ~doubling their
  alpha — the grid read too heavy); the KO white/red flash is clipped to the board
  outline (no more flash in the rectangular corners); confetti fires on every line
  clear (white on single/double, palette on triple) not just triples; the
  double/triple popup scale-pops (0.5→1.2→1.0); and a soft accent radial vignette
  sits behind the lobby content (web lobby glow).
- **Polish pass (verified in the tvOS Simulator).** The lobby falling pieces now
  render as gradient piece stamps (the NORMAL recipe the game pieces use) instead
  of flat silhouettes; the match timer lays each glyph on a fixed advance so digits
  don't shift as the seconds tick (web drawTimer); lock/clear/KO sparkles arc under
  gravity with rotation + a size range (web `_addSparkle`); the garbage
  telegraph/defence flash draws the white top-edge bevel stripe (web
  `_drawGarbageEffects`); and the garbage shake is a decaying sinusoid (web
  `addGarbageShake`, also fixing the old jitter being ~5× too strong). The `HEXDEMO`
  self-play harness keeps its synthetic players "seen" so the liveness sweep no
  longer auto-pauses it after 3 s.
- **Perf:** the live piece + ghost skip their per-frame node rebuild unless their
  cells/type/tier actually changed (keyed like the existing preview cache); the QR
  generator reuses one shared `CIContext` instead of allocating one per render;
  and `updateLobby` skips the (invisible) full lobby rebuild when the lobby isn't
  the current screen, so mid-match roster churn no longer re-renders it behind the
  game.
- **CI:** the `tvos-core` job runs `swift build` + `swift test`, and a
  new `tvos-app` job builds the app target for the Simulator SDK (the app-target
  sources — DisplayModel/BoardNode/WebRTCFastlane — are not in the SwiftPM package, so
  `swift build` never compiled them). `project.yml` excludes the missing x86_64
  slice for the Simulator so a generic/CI simulator build links (LiveKitWebRTC
  ships only an arm64 tvOS-sim slice).

**Known minor deltas (deliberately not changed):** two subtle items remain — the
anti-banding SVG-noise dither on the countdown/results gradients (not visible in
full-bit-depth capture, only faint banding on some 8-bit panels) and suppressing
the near-clear pulse under the active piece (mostly occluded by the piece stamp
anyway, and adding it would defeat the gridVersion cache the pulse relies on). The
whole-screen overscan inset (boards sit inside the tvOS title-safe area vs the
web's near-full-bleed) is intentional.

### Kit hardening round (code review)

- **Owning-thread assertions.** The coordinator's single-threaded contract (one
  thread owns the fields and the JSContext) was enforced only by a doc comment;
  every entry point (tick, transport handlers, setRelayConnected) now asserts
  the constructing thread in debug, so a RelayClient wired to a non-main
  callbackQueue fails fast instead of racing the JS VM.
- **Exception-box drain on every bridge path.** EngineBridge's decode path now
  drains the JS exception box before inspecting the return value; previously a
  JS throw could bail on the nil-string guard with the message still boxed,
  mis-attributed to the next frame(). frame() also now reuses decode().
- **Typed results plumbing.** The enriched match ranking is a `MatchResult`
  struct end-to-end (coordinator, lastResults replay, DisplayOutput,
  RootScene); the `[String: Any]` wire form is produced only at the transport
  boundary via `payload`.
- **Gallery/demo split.** The screenshot-fixture rendering and the self-play
  demo moved to `DisplayCoordinator+Gallery.swift`; the coordinator file itself
  is live-game logic only.
- **EngineConstants drift guard.** `ParityTests` pins every value of the
  hand-mirrored `EngineConstants` to the canonical `server/constants.js`
  exports (the one engine mirror the golden tests didn't cover).
- **tick() frame failures surfaced.** A frame decode failure now logs to
  stderr instead of being silently dropped (a persistent one froze the game
  with no signal).

### Implemented (design + features round)

Gameplay (BoardNode):
- Falling piece / ghost / locked stack render correctly (layering fixed).
- Full HUD: HOLD, NEXT (3 pieces), LEVEL/LINES, player name, garbage meter.
- **Zigzag clear preview** — white highlight on the cells that will clear when
  the ghost lands (`Zigzag.clearable`, cached by ghost anchor/rotation + grid).
- **Near-clear pulse** — pulsing white outline on empty cells one drop from a
  clear (`Zigzag.nearClear`, cached by `gridVersion`).
- **Clearing-cells glow** — pulsing white fill on cells mid line-clear.
- Animations: lock-flash sparkles, line-clear flash + DOUBLE/TRIPLE popup +
  triple confetti, KO flash + overlay, garbage shake.
- **Match timer** (MM:SS from `snapshot.elapsed`), centered or left-anchored for
  odd board counts, matching the web.

Web-parity pass (workflow-driven): a per-screen web↔Swift diff drove ~25 fidelity
fixes — results recomposed to match the web (no heading, single-line rank/name/
stats rows, sentence-case stats, soft radial winner glow), pause/countdown text
resized to the web clamps, MenuButton switched to a 12px gradient rounded-rect,
font-weight + letter-spacing parity (a `setStyledText` kern helper), KO red wash
instead of dimming the whole board, neon-black HOLD/NEXT panels at Lv 11+, and
lobby polish (SCAN TO JOIN, join-URL pill, START with player count).

Lobby / countdown / results (built in RootScene, since migrated to the SwiftUI chrome):
- **Lobby** matches the web: baked 8-stop gradient HEX STACKER wordmark + PARTY
  subtitle, animated falling-piece background, QR card with SCAN OR VISIT +
  host/code join URL, player-card grid (player-colored border + name + LEVEL
  pill, dashed empty slots, join-pop animation), host-tinted status pill.
  Supports up to 8 players (2 cols ≤4, 4 cols 5-8). Card + QR sizes are capped
  (web clamps them) and the QR card height matches the 2-row grid, so the body
  reads as a balanced pair and cards stay one size across player counts.
- **Countdown** is a full-screen dim overlay with an accent-red number + beat.
- **Results** are ranked cards (rank ordinal + name in player color, lines/level
  stats, winner glow, staggered fade-in, dashed late-joiner rows), titled with
  the brand wordmark (the web results screen has no "RESULTS" heading; the only
  title in the app is the wordmark).

Platform / chrome:
- **Focusable on-screen buttons** (lobby START GAME, results PLAY AGAIN / NEW
  GAME, pause CONTINUE / NEW GAME) navigable with the Siri Remote:
  - **Select** activates the focused button.
  - **Play/Pause** is the context action: Start (lobby) / Pause (game) /
    Continue (paused) / Play Again (results).
  - **Menu** pauses/resumes during a game (and exits normally at the top level).
  - **d-pad Left/Right/Up/Down** move focus across a row/column grid (the pause
    overlay has the music switch on a row above Continue / New Game). Works by
    *clicking* the d-pad ring AND by *swiping* the touch surface (a swipe emits
    no arrow press, so `UISwipeGestureRecognizer`s drive focus too).
  - **Music** is the host's **"Game Music" settings row** in the **pause
    overlay** (label left, switch right), spanning the button-pair width so its
    focus frame is proportional. The switch mirrors the web `.settings-switch`
    (52:30 pill, white thumb, ON tinted by the host's player color, OFF a faint
    translucent white). It is the same display-mute the web exposes as the
    status-bar speaker icon and the host controller's "Game Music" setting. No
    dedicated remote button; quick silencing uses the hardware volume.
  - **Pause works during the countdown too** (web parity) — Play/Pause and Menu
    freeze the 3-2-1 and show the pause overlay (zPosition 90, above the countdown
    layer at 80), so the two never visually conflict.
  A paired Bluetooth keyboard mirrors these (Return/Space activate, P play/pause,
  ←/→ focus, Esc menu/pause). Gameplay input is still the phones.
- **Layout verification** — `scripts/parity/content-bounds.mjs` measures the
  content bounding box in a screenshot and reports clipping vs the screen and the
  tvOS title-safe area. Confirms no screen clipping; the debug FPS/node overlay
  is now gated behind `HEXFPS=1` (it lives in the overscan corner).
- **Title-safe layout** — all screens inset to the tvOS overscan safe area
  (≈60pt top/bottom, 80pt left/right) so nothing is clipped at the TV edges.
- **Weighted Orbitron** — the variable font's named instances (Bold / ExtraBold
  / Black) are selected per element instead of rendering everything at Regular.
- **Boards visible during the countdown** — the engine is built at countdown
  start and the game screen shows behind a light scrim + the 3-2-1-GO number.
- Lobby cards refresh live when a controller changes name / color / level
  (`broadcastLobby` now also rebuilds the display's own lobby).
- **Orbitron** variable font bundled + used (falls back to system if absent).
- **tvOS Brand Assets** app-icon catalog (compiles with `actool`, builds for device).
- **Board outline wall** ported from `computeHexOutlineVerts` (real perimeter,
  well clip + outer wall stroke).
- **Two disconnect overlays, mirroring the web:** (1) a single controller
  dropping shows a **per-board** dim + claim-URL QR + "SCAN TO REJOIN"
  (`BoardNode.setDisconnected`); (2) the display's own relay link dropping shows
  a **full-screen** overlay — "RECONNECTING" + "Connection lost…" while auto-
  retrying, then "DISCONNECTED" + a focusable RECONNECT once given up (driven by
  `RelayClient.onConnectionState`).

Fix: `endGame` now reveals the results layer (`showScreen(.results)`) — previously
the results were built but never shown, freezing on the last game frame.

Cross-engine parity tests — both layers:
- Data parity (`ParityTests`): geometry, cell centers, palettes,
  tiers, color math, **and zigzag clear/near-clear detection** byte-identical to
  the web JS.
- **Visual/pixel parity** (`scripts/parity/`): the web canvas and the native
  SpriteKit render draw the shared fixture identically — **9/9 cells agree**,
  near-identical RGB (within rasterizer rounding).

Headless / verification modes:
- `HEXDEMO=1` — self-playing game (synthetic input, no relay).
- `HEXLOBBY=1` — lobby populated with fake players (no relay) for UI capture.
- `HEXSNAP=1` — static fixture render for visual-parity capture.
- `HEXSHOT=<state>` — render one display state frozen with fake data, for the
  screen gallery (`HEXPLAYERS=<n>`). See the repo-root `scripts/gallery/`.
- `HEXGALLERY=1` — carousel: present every gallery state in ONE launch, advancing
  on Play/Pause. `DisplayModel.galleryStates` is the ordered source of truth
  and reports each rendered state's name via the `hexshot-marker` accessibility
  element; the `ScreenshotTests` UI test drives it (one launch, not one per state).

Screen gallery (repo-root `scripts/gallery/`) — the cross-platform screenshot
mechanism modelled on the web `public/gallery.html`: locally, `capture-tvos.sh`
renders every state in `scenarios.json` via `HEXSHOT` and screenshots it from the
Simulator; in CI the `tvOS` workflow's `ScreenshotTests` captures the same states
via the `HEXGALLERY` carousel. `capture-web.mjs` and the Android Roborazzi tests
supply the other columns; `gen-gallery.mjs` assembles `gallery.html` with web vs
tvOS vs Android TV side by side for gap review. Shots + page are git-ignored
(regenerable); CI assembles the same page via the `TV Gallery` workflow.

## Next steps

Remaining work is real-hardware / live validation; the app, animations, and both
disconnect overlays are built and run in the Simulator (see above).

1. Play end-to-end against the live relay: open a phone browser to the QR target and
   run a full match on a real Apple TV.
2. Profile rendering on real Apple TV hardware (the per-frame board rebuild is naive —
   see "Deliberate v1 scope cuts").
3. Exercise the WebRTC input fastlane with a real phone controller (it builds, links,
   and launches already) — see the WebRTC fastlane section above.
