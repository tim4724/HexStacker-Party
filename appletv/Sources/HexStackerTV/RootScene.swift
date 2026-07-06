import SpriteKit
import CoreImage
import HexStackerKit

/// The single SpriteKit scene for the whole display. Owns the relay client and
/// the DisplayCoordinator, implements DisplayOutput, and drives the coordinator
/// once per frame from `update(_:)`. Renders the lobby / game / results screens
/// plus a countdown overlay. Ported in spirit from the web display shell.
final class RootScene: SKScene, DisplayOutput {

    private var relay: RelayClient!
    private var coordinator: DisplayCoordinator!
    private let music = MusicPlayer()

    // Lobby = animated falling-piece background + rebuilt content layer.
    private let lobbyLayer = SKNode()
    private let lobbyBg = LobbyBackgroundNode()
    private let lobbyGlow = SKSpriteNode()   // soft accent-red radial vignette (web lobby glow)
    private let lobbyContent = SKNode()

    private let gameLayer = SKNode()
    // Wraps gameLayer so the results screen can blur the frozen boards behind it
    // (the web's frosted-glass --overlay-bg + backdrop blur). Effects stay OFF
    // during play (zero cost); showScreen toggles them only for results.
    private let gameEffect = SKEffectNode()
    private let resultsLayer = SKNode()
    private let timerNode = SKNode()          // container for the fixed-advance timer glyphs
    private var lastTimerKey = ""             // change-gate for the once-a-second timer text
    private var timerGlyphs: [SKLabelNode] = []

    // Countdown overlay (dim + number), independent of the three screens.
    private let countdownLayer = SKNode()
    private let countdownDim = SKShapeNode()
    private let countdownNumber = SKLabelNode()

    // Paused overlay (remote / controller driven) + transient mute indicator.
    private let pauseLayer = SKNode()
    private let pauseDim = SKShapeNode()
    private let pauseTitle = SKLabelNode()
    private weak var musicToggle: MusicSwitch?   // music on/off in the pause menu

    // Full-screen DISPLAY-connection overlay (the display's own relay link is
    // reconnecting / lost). Distinct from a single controller dropping, which is
    // a per-board QR overlay (BoardNode.setDisconnected).
    private let connLayer = SKNode()
    private let connDim = SKShapeNode()
    private let connHeading = SKLabelNode()
    private let connStatus = SKLabelNode()
    private weak var connButton: MenuButton?

    // "Open Source Licenses" overlay, drilled into from the About screen and
    // scrolled with the d-pad. Above every other overlay so it owns the remote.
    private let licenses = LicensesOverlay()

    // About overlay (Privacy / Imprint QR + the Open Source Licenses drill-in),
    // opened from the lobby ⓘ button. Sits just below the licenses overlay.
    private let about = AboutOverlay()

    private var boardNodes: [Int: BoardNode] = [:]
    private var currentPlayerCount = -1
    private var lastBoardIds: [Int] = []   // the player-id set the boards were built for
    private var lastTime: TimeInterval = 0
    private var shotMode = false   // HEXSHOT: render one frozen state, no live tick
    private var relayStarted = false   // false in the offline harness modes

    // Gallery carousel (GameViewController drives it): render a specific frozen
    // state set programmatically instead of from the HEXSHOT env var, so ONE app
    // launch can cycle through every state. `onShotRendered` fires shortly after
    // the frame is on screen (labels/QR/board textures settled) so the UI test
    // captures a complete screen without a fixed per-state sleep.
    var shotOverride: (name: String, shot: String, playerCount: Int)?
    var onShotRendered: ((String) -> Void)?
    private var pendingReadyName: String?
    private var shotStartTime: TimeInterval = 0

    // Player ids already shown in the lobby — used to fire the join-pop only on
    // newly arriving players, not on every roster rebuild.
    private var lobbyKnownPlayers: Set<Int> = []

    // tvOS overscan / title-safe area. Honor the full system-reported safe-area
    // insets per Apple's HIG (≈60pt top/bottom, 80pt left/right on 1080p); content
    // lays out inside playRect while full-bleed backgrounds still fill `size`.
    private var safe = UIEdgeInsets.zero
    private var playRect: CGRect {
        return CGRect(x: safe.left, y: safe.bottom,
                      width: max(1, size.width - safe.left - safe.right),
                      height: max(1, size.height - safe.top - safe.bottom))
    }

    override func didMove(to view: SKView) {
        backgroundColor = SKTheme.bgPrimary
        scaleMode = .resizeFill
        safe = view.safeAreaInsets

        // Localize the display from the device language using the table generated
        // from public/shared/i18n.js (bundled next to the engine). Must run before
        // any screen renders, including the HEXSHOT / HEXLOBBY / HEXDEMO paths.
        Localization.shared.configure(engineDirectory: AssetLocator.engineDirectory)

        lobbyLayer.addChild(lobbyBg); lobbyBg.zPosition = 0
        lobbyLayer.addChild(lobbyGlow); lobbyGlow.zPosition = 0.5   // soft accent vignette, above pieces / below content
        lobbyLayer.addChild(lobbyContent); lobbyContent.zPosition = 1
        lobbyBg.configure(size: size)
        layoutLobbyGlow()

        addChild(lobbyLayer)
        gameEffect.shouldEnableEffects = false   // OFF during play; on only for results
        gameEffect.shouldRasterize = false       // rasterize only for the static results screen (showScreen)
        gameEffect.filter = CIFilter(name: "CIGaussianBlur", parameters: [kCIInputRadiusKey: 18])
        gameEffect.addChild(gameLayer)
        addChild(gameEffect)
        resultsLayer.zPosition = 1               // above the (blurred) game layer
        addChild(resultsLayer)

        // Match timer (top of the game screen). Per-glyph so digits sit on fixed
        // advances and don't shift as the seconds tick (web drawTimer).
        timerNode.zPosition = 20
        timerNode.isHidden = true
        gameLayer.addChild(timerNode)

        buildCountdownOverlay()
        buildPauseOverlay()
        buildConnectionOverlay()
        licenses.configure(size: size, playRect: playRect)
        addChild(licenses.node)
        about.configure(size: size, playRect: playRect)
        about.onOpenLicenses = { [weak self] in self?.openLicenses() }
        addChild(about.node)
        // Capture hook (mirrors HEXSHOT / HEXSNAP): open the licenses page straight
        // away so it can be screenshotted deterministically — the tvOS simulator has
        // no Siri-Remote CLI to navigate to it. Inert without the env var.
        if ProcessInfo.processInfo.environment["HEXLICENSES"] != nil { openLicenses() }

        // Visual-parity capture: render the fixed fixture board and stop.
        if ProcessInfo.processInfo.environment["HEXSNAP"] != nil {
            renderStaticFixture()
            return
        }

        relay = RelayClient()
        // Optional WebRTC input fastlane: controller input rides peer-to-peer
        // DataChannels when open, with the relay as signaling + fallback. Built
        // only when the WebRTC framework is linked (canImport); otherwise nil and
        // all input flows over the relay (the v1 behavior). Signaling rides the
        // relay via sendTo, mirroring the web display.
        let fastlane: InputFastlane?
        #if canImport(LiveKitWebRTC)
        fastlane = WebRTCFastlane.make(stunURL: HexStackerKit.Protocol.stunURL,
                                       sendSignal: { [weak self] idx, data in self?.relay?.sendTo(idx, data) })
        #else
        fastlane = nil
        #endif
        coordinator = DisplayCoordinator(transport: relay,
                                         engineDirectory: AssetLocator.engineDirectory,
                                         output: self,
                                         fastlane: fastlane)

        // The display's own relay link dropping shows a full-screen overlay
        // (distinct from a single controller dropping = per-board QR), AND freezes
        // the simulation so it can't run blind (KO'ing players who can't send
        // input) behind the overlay; reconnecting resumes it.
        relay.onConnectionState = { [weak self] state in
            guard let self else { return }
            switch state {
            case .reconnecting:
                self.coordinator?.setRelayConnected(false)
                self.showConnectionOverlay(reconnecting: true)
            case .closed:
                self.coordinator?.setRelayConnected(false)
                self.showConnectionOverlay(reconnecting: false)
            case .open:
                self.coordinator?.setRelayConnected(true)
                self.hideConnectionOverlay()
            case .connecting, .idle:
                self.hideConnectionOverlay()
            }
        }
        // Evicted because another client claimed the "display" slot: reconnecting
        // would start a takeover war, so show a terminal disconnect with no button.
        relay.onReplaced = { [weak self] in
            self?.coordinator?.setRelayConnected(false)
            self?.showConnectionOverlay(reconnecting: false, allowReconnect: false)
        }
        // Live "Attempt N of M" on the reconnect overlay (web parity).
        relay.onReconnecting = { [weak self] attempt, max in
            self?.updateReconnectStatus(attempt: attempt, max: max)
        }

        // Screenshot gallery: render one frozen state with fake data and stop
        // ticking, so a screenshot captures exactly that screen. The state comes
        // from the gallery carousel (shotOverride, one launch cycles through every
        // state) or a single HEXSHOT=<state> launch (workflow_dispatch / local).
        // States: lobby, lobby-empty, countdown, game[-lv8/-lv12/-2p/-3p/-4p],
        // pause[-music], disconnected[-controller], reconnecting,
        // disconnected-display, results[-solo]; HEXPLAYERS=<n>.
        if let override = shotOverride {
            shotMode = true
            applyShot(override.shot, playerCount: override.playerCount)
            pendingReadyName = override.name
            return
        }
        if let shot = ProcessInfo.processInfo.environment["HEXSHOT"] {
            shotMode = true
            let pc = ProcessInfo.processInfo.environment["HEXPLAYERS"].flatMap { Int($0) } ?? 4
            applyShot(shot, playerCount: pc)
            pendingReadyName = shot
            return
        }

        // Lobby UI verification: populate fake players (no relay) so filled
        // player cards / host tint can be exercised without controllers.
        if ProcessInfo.processInfo.environment["HEXLOBBY"] != nil {
            coordinator.startLobbyDemo(playerCount: 3)
            return
        }

        // Self-playing local game (no relay), for rendering verification. Must
        // NOT call start() — the relay's async onCreated would flip the screen
        // back to the lobby mid-demo.
        if ProcessInfo.processInfo.environment["HEXDEMO"] != nil {
            showScreen(.lobby)
            coordinator.startLocalDemo(playerCount: 2)
            return
        }

        coordinator.start()
        relayStarted = true
        showScreen(.lobby)
        // Render the waiting-lobby scaffold immediately so the create-failure overlay
        // sits on top of the lobby (not a bare background) and there's no empty-screen
        // flash before the room arrives.
        buildWaitingLobby()
    }

    /// Render a single frozen gallery state. Shared by the HEXSHOT env launch and
    /// the gallery carousel so both produce byte-identical screens; the special
    /// cases layer an overlay / focus move on top of a base `renderShot`.
    private func applyShot(_ shot: String, playerCount pc: Int) {
        switch shot {
        case "pause-music":   // pause overlay with the MUSIC switch focused
            coordinator.renderShot("pause", playerCount: pc)
            remoteUp()
        case "reconnecting":  // full-screen display-disconnect overlay over a game
            coordinator.renderShot("game", playerCount: pc)
            showConnectionOverlay(reconnecting: true)
            // Gallery parity with web (DisplayTestHarness shows "Attempt 2 of 5"):
            // the live retry tick that would set this never fires in a static shot.
            updateReconnectStatus(attempt: 2, max: 5)
        case "disconnected-display":
            coordinator.renderShot("game", playerCount: pc)
            showConnectionOverlay(reconnecting: false)
        case "create-error-retry":  // first-launch create failed, auto-retrying
            // Reconnect overlay over the empty, room-less waiting lobby (matching
            // web): a failed create now reads exactly like a lost room.
            showScreen(.lobby)
            buildWaitingLobby()
            showConnectionOverlay(reconnecting: true)
            // Static shot has no live retry tick; seed the counter at its start.
            updateReconnectStatus(attempt: 1, max: 5)
        case "create-error":        // create attempts exhausted → DISCONNECTED + RECONNECT
            showScreen(.lobby)
            buildWaitingLobby()
            showConnectionOverlay(reconnecting: false)
        case "about":         // full-screen About overlay (Privacy / Imprint QR + Licenses drill-in)
            coordinator.renderShot("lobby-empty", playerCount: pc)
            openAbout()
        case "licenses":      // full-screen Open Source Licenses overlay (scrolled to top)
            coordinator.renderShot("lobby-empty", playerCount: pc)
            openLicenses()
        default:
            coordinator.renderShot(shot, playerCount: pc)
        }
    }

    /// App returned to the foreground. Backgrounding broadcast DISPLAY_CLOSED
    /// (notifyDisplayClosing) but kept the socket, so after a quick Home-and-back
    /// nothing detects a drop and the controllers stay stranded on their end
    /// screens. Force a fresh join: `joined` replays the roster through the
    /// coordinator's onJoined, which reconciles presence and re-welcomes every
    /// controller, the same recovery the web gets from a page reload.
    func appWillEnterForeground() {
        guard relayStarted else { return }   // HEXSHOT/HEXLOBBY/HEXDEMO never connect
        relay?.reconnectNow()
    }

    override func update(_ currentTime: TimeInterval) {
        let deltaMs = lastTime == 0 ? 0 : (currentTime - lastTime) * 1000.0
        lastTime = currentTime
        if let insets = view?.safeAreaInsets, insets != safe { safe = insets; relayout() }
        if !lobbyLayer.isHidden {
            lobbyBg.tick(dt: CGFloat(min(deltaMs, 50.0) / 1000.0))
        }
        if !shotMode { coordinator?.tick(deltaMs: deltaMs) }   // nil in HEXSNAP; frozen in HEXSHOT

        // Gallery readiness: once a frozen state has been on screen briefly (so
        // labels / QR / board textures have rasterized), report its name so the UI
        // test can capture it and advance the carousel. Time-based off the scene
        // clock; the process is already warm, so this is far cheaper than the old
        // per-state cold launch + fixed sleep.
        if let name = pendingReadyName {
            if shotStartTime == 0 { shotStartTime = currentTime }
            if currentTime - shotStartTime >= 0.8 {
                pendingReadyName = nil
                shotStartTime = 0
                onShotRendered?(name)
            }
        }
    }

    /// Re-apply layout after the safe-area insets become known (they are zero
    /// until the first layout pass, then settle at the overscan margins).
    private func relayout() {
        countdownDim.path = CGPath(rect: CGRect(origin: .zero, size: size), transform: nil)
        countdownNumber.position = CGPoint(x: playRect.midX, y: playRect.midY)
        currentPlayerCount = -1   // force boards to re-lay-out on the next snapshot
        lastBoardIds = []
        layoutLobbyGlow()
        if !lobbyLayer.isHidden, let room = lobbyRoom {
            buildLobby(room: room, joinURL: lobbyJoinURL ?? "",
                       players: coordinator?.flow.list() ?? [], host: coordinator?.flow.host)
        }
    }

    /// Size + place the soft accent-red radial vignette behind the lobby content
    /// (web display.js draws a radial-gradient tint at 50% / 30% from the top).
    private func layoutLobbyGlow() {
        guard size.width > 0, size.height > 0 else { return }
        let d = max(size.width, size.height) * 1.15
        if lobbyGlow.shader == nil {
            lobbyGlow.texture = Self.glowUnit
            lobbyGlow.shader = Self.glowShader(color: SKTheme.accentPrimary, centerAlpha: 0.06)
        }
        lobbyGlow.size = CGSize(width: d, height: d)
        lobbyGlow.position = CGPoint(x: size.width / 2, y: size.height * 0.7)   // 30% from the top
    }

    // MARK: - DisplayOutput

    func showScreen(_ screen: DisplayScreen) {
        // The About / licenses overlays are lobby-only; a match starting (from a
        // controller while one is open) must not leave it stranded over the game.
        if screen != .lobby { closeLicenses(); closeAbout() }
        lobbyLayer.isHidden = screen != .lobby
        // Results overlays the frozen, blurred boards (web frosted-glass look), so
        // the game layer stays visible underneath and the blur turns on for results.
        gameLayer.isHidden = screen != .game && screen != .results
        // Effects + rasterization scoped to the static results screen: leaving
        // rasterization on across the every-frame-mutating game layer would force a
        // full-screen re-bake whenever a board changes.
        gameEffect.shouldEnableEffects = screen == .results
        gameEffect.shouldRasterize = screen == .results
        resultsLayer.isHidden = screen != .results
        countdownLayer.isHidden = true
        // Gameplay has no on-screen menu (lobby/results set their own; the pause
        // overlay sets/clears its menu in setPaused). Entering the game screen
        // starts a fresh match, so force a board rebuild even if the new roster
        // happens to match the previous one's size.
        if screen == .game { setMenu([]); lastBoardIds = [] }
        if screen != .lobby { lobbyEntranceDone = false }   // replay entrance on re-enter
    }

    func roomReady(room: String, joinURL: String, qrText: String) {
        lobbyQRText = qrText
        buildLobby(room: room, joinURL: joinURL, players: coordinator.flow.list(), host: coordinator.flow.host)
    }

    /// The pre-room lobby scaffold: title, empty player grid, and a BLANK QR card
    /// (no room exists until the relay answers `created`). Rendered from launch and
    /// behind the create-failure overlay so it sits on top of the lobby (matching the
    /// web display); `roomReady` rebuilds it with the real room + QR.
    private func buildWaitingLobby() {
        buildLobby(room: "", joinURL: "", players: [], host: nil)
    }

    func updateLobby(players: [PlayerRecord], hostPeerIndex: Int?) {
        guard let room = lobbyRoom else { return }
        // Only rebuild while the lobby is the live screen. Roster churn during
        // countdown/playing/results still fires onRosterChange, but rebuilding the
        // (hidden) title texture + QR + every player card behind the game is wasted
        // work. returnToLobby transitions to .lobby before broadcasting, so the
        // rebuild that repopulates the lobby on match end is not skipped.
        guard coordinator?.state == .lobby else { return }
        buildLobby(room: room, joinURL: lobbyJoinURL ?? "", players: players, host: hostPeerIndex)
    }

    func showCountdown(_ value: CountdownValue) {
        countdownLayer.isHidden = false
        timerNode.isHidden = true   // no match timer until play begins
        countdownDim.removeAllActions()
        countdownDim.alpha = 1
        countdownNumber.removeAllActions()
        countdownNumber.alpha = 1
        switch value {
        case .number(let n): countdownNumber.text = "\(n)"
        case .go: countdownNumber.text = tr("go")
        }
        countdownNumber.setScale(0.7)
        let pop = SKAction.scale(to: 1.0, duration: 0.18); pop.timingMode = .easeOut
        if case .go = value {
            countdownNumber.run(.sequence([pop, .wait(forDuration: 0.35),
                                           .group([.fadeOut(withDuration: 0.25), .scale(to: 1.18, duration: 0.25)])]))
            countdownDim.run(.sequence([.wait(forDuration: 0.4), .fadeOut(withDuration: 0.25),
                                        .run { [weak self] in self?.countdownLayer.isHidden = true }]))
        } else {
            // Subtle "beat" while the number is up (matches countdownBeat).
            countdownNumber.run(.sequence([pop, .scale(to: 1.06, duration: 0.4), .scale(to: 1.0, duration: 0.4)]))
        }
    }

    func renderSnapshot(_ snapshot: GameSnapshot) {
        ensureBoards(for: snapshot)
        for p in snapshot.players {
            boardNodes[p.id]?.update(with: p)
        }
        updateTimer(elapsedMs: snapshot.elapsed)
    }

    func handleGameEvent(_ event: GameEvent) {
        switch event.type {
        case "piece_lock":
            if let id = event.playerId { boardNodes[id]?.flashLock(event.blocks ?? [], typeId: event.typeId ?? 0) }
        case "line_clear":
            if let id = event.playerId { boardNodes[id]?.lineClearEffect(event.clearCells ?? [], lines: event.lines ?? 1) }
        case "garbage_sent":
            if let id = event.toId {
                boardNodes[id]?.shake()
                // Telegraph incoming garbage in the attacker's player color.
                let color = event.senderId
                    .flatMap { coordinator?.flow.player($0)?.colorSlot }
                    .map { SKTheme.player(slot: $0) } ?? SKTheme.accentPrimary
                boardNodes[id]?.flashGarbageIncoming(lines: event.lines ?? 1, color: color)
            }
        case "garbage_cancelled":
            if let id = event.playerId { boardNodes[id]?.flashGarbageDefence(lines: event.lines ?? 1) }
        case "player_ko":
            if let id = event.playerId { boardNodes[id]?.flashKO() }
        default:
            break
        }
    }

    func setDisconnected(playerId: Int, joinURL: String?) {
        boardNodes[playerId]?.setDisconnected(joinURL)
    }

    func setLobbyAmbient(_ pieces: [AmbientPiece]) {
        lobbyBg.freeze(pieces)   // gallery lobby shots: freeze the falling-piece background
    }

    func setPaused(_ paused: Bool) {
        // Rebuild the pause rows (positions depend on the play rect). Remove the
        // music switch too, not just the buttons: a stale MusicSwitch left behind
        // stacks under the fresh one, and once the mute state differs between two
        // pause sessions both knobs show at once.
        pauseLayer.children.filter { $0 is MenuButton || $0 is MusicSwitch }.forEach { $0.removeFromParent() }
        if paused {
            let cx = playRect.midX, cy = playRect.midY
            // Three evenly-spaced rows centered on the overlay: PAUSED / music / buttons.
            let rowSpacing = playRect.height * 0.13
            pauseTitle.position = CGPoint(x: cx, y: cy + rowSpacing)
            let btnH = max(48, playRect.height * 0.075)
            let btnW = max(playRect.width * 0.18, btnH * 4.5)
            let gap = playRect.width * 0.03
            let hostColorOpt = coordinator.flatMap { c in c.flow.host.flatMap { c.flow.player($0)?.colorSlot } }
                .map { SKTheme.player(slot: $0) }
            let hostColor = hostColorOpt ?? SKTheme.accentPrimary

            // "Game Music" settings row above the action buttons (reachable with
            // d-pad Up), spanning the button pair's width so its focus frame is
            // proportional. ON tint = host color (web --player-color).
            let muted = coordinator?.isMuted ?? false
            let musicRow = MusicSwitch(width: btnW * 2 + gap, height: btnH, isOn: !muted,
                                       tint: hostColorOpt ?? SKTheme.accentSecondary) { [weak self] in self?.toggleMusic() }
            musicRow.position = CGPoint(x: cx, y: cy)
            musicToggle = musicRow

            let cont = MenuButton(text: trUpper("continue_btn"), width: btnW, height: btnH, primary: true,
                                  tint: hostColor) { [weak self] in self?.coordinator?.remoteTogglePause() }
            // Neutral secondary (card fill + 1px rim, cream label) — matches the web
            // `.btn-secondary` and the results "New Game", so no secondary reads as
            // an accent/host color. Continue is the sole filled host CTA.
            let ng = MenuButton(text: trUpper("new_game"), width: btnW, height: btnH, primary: false,
                                tint: hostColor) { [weak self] in self?.coordinator?.remoteReturnToLobby() }
            cont.position = CGPoint(x: cx - btnW / 2 - gap / 2, y: cy - rowSpacing)
            ng.position = CGPoint(x: cx + btnW / 2 + gap / 2, y: cy - rowSpacing)
            // Above pauseDim (see buildPauseOverlay: equal-z order is undefined
            // under ignoresSiblingOrder).
            for row in [musicRow, cont, ng] { row.zPosition = 1 }
            pauseLayer.addChild(musicRow)
            pauseLayer.addChild(cont)
            pauseLayer.addChild(ng)
            setMenu([[musicRow], [cont, ng]], focus: (1, 0))   // default focus = Continue
        } else {
            setMenu([])
        }
        pauseLayer.isHidden = !paused
    }

    private func toggleMusic() {
        // The knob follows via the coordinator's setDisplayMuted callback, the
        // same path that keeps it live when the host phone toggles Game Music.
        coordinator?.remoteToggleMute()
    }

    func setDisplayMuted(_ muted: Bool) {
        musicToggle?.setOn(!muted)   // switch shows "music on", the inverse of mute
    }

    // MARK: - Apple TV remote (display-side controls)

    // Focusable items as a grid of rows (top→bottom); navigated with the d-pad:
    // Left/Right within a row, Up/Down between rows.
    private var menuRows: [[Focusable]] = []
    private var focusRC: (r: Int, c: Int) = (0, 0)
    // The menu stashed while an input-blocking overlay (connection) is up, so the
    // overlay can't leak Select to the screen behind it or leave focus dangling.
    private var savedMenuRows: [[Focusable]]?
    private var savedFocusRC: (r: Int, c: Int) = (0, 0)

    // Sentinel focus for a menu that starts unfocused (`autoFocus: false`): no item
    // is highlighted until the first d-pad press, which lands on firstEnabled().
    private static let noFocus = (-1, -1)

    private func setMenu(_ rows: [[Focusable]], focus: (Int, Int)? = nil, autoFocus: Bool = true) {
        // While the connection overlay is up it owns the live menu. A screen
        // rebuilding underneath (roster change in the lobby, results, pause)
        // must land in the stash instead; otherwise hideConnectionOverlay
        // would restore the old, since-detached rows and strand focus on nodes
        // no longer in the scene.
        let f = autoFocus ? focus : RootScene.noFocus
        if savedMenuRows != nil {
            savedMenuRows = rows
            savedFocusRC = f ?? (0, 0)
            return
        }
        applyMenu(rows, focus: f)
    }

    /// Install `rows` as the live menu, bypassing the overlay stash; only the
    /// connection overlay's own show/hide paths call this. A `focus` of
    /// `noFocus` seats nothing (see `setMenu(autoFocus:)`).
    private func applyMenu(_ rows: [[Focusable]], focus: (Int, Int)? = nil) {
        menuRows = rows
        if let f = focus, f == RootScene.noFocus {
            focusRC = RootScene.noFocus
        } else if let f = focus, rows.indices.contains(f.0), rows[f.0].indices.contains(f.1), rows[f.0][f.1].enabled {
            focusRC = f
        } else {
            focusRC = firstEnabled() ?? (0, 0)
        }
        refreshFocus()
    }

    private func firstEnabled() -> (Int, Int)? {
        for (r, row) in menuRows.enumerated() {
            if let c = row.firstIndex(where: { $0.enabled }) { return (r, c) }
        }
        return nil
    }

    private func refreshFocus() {
        for (r, row) in menuRows.enumerated() {
            for (c, item) in row.enumerated() { item.setFocused(r == focusRC.r && c == focusRC.c) }
        }
    }

    private func moveFocus(dRow: Int, dCol: Int) {
        // From the unfocused state (autoFocus: false), any d-pad press just seats
        // focus on the first enabled item rather than moving relative to nothing.
        guard menuRows.indices.contains(focusRC.r) else {
            if let f = firstEnabled() { focusRC = f; refreshFocus() }
            return
        }
        if dCol != 0 {
            let row = menuRows[focusRC.r]
            if row.count > 1 {
                var c = focusRC.c
                for _ in 0..<row.count { c = (c + dCol + row.count) % row.count; if row[c].enabled { focusRC.c = c; break } }
            }
        }
        if dRow != 0 {
            var r = focusRC.r
            while true {
                r += dRow
                if r < 0 || r >= menuRows.count { break }   // no vertical wrap
                if menuRows[r].contains(where: { $0.enabled }) {
                    focusRC.r = r
                    var c = min(focusRC.c, menuRows[r].count - 1)
                    if !menuRows[r][c].enabled { c = menuRows[r].firstIndex(where: { $0.enabled }) ?? 0 }
                    focusRC.c = c
                    break
                }
            }
        }
        refreshFocus()
    }

    /// Select: activate the focused item. No-op during gameplay (no menu) and while
    /// the licenses page is up (it is a document, not a menu). While About is up it
    /// drills into the licenses page (its single button is always the target).
    func remotePrimary() {
        if licenses.isOpen { return }
        if about.isOpen { about.activate(); return }
        guard menuRows.indices.contains(focusRC.r), menuRows[focusRC.r].indices.contains(focusRC.c) else { return }
        let item = menuRows[focusRC.r][focusRC.c]
        if item.enabled { item.activate() }
    }

    /// Play/Pause: context toggle (start / play again / pause / continue). Inert
    /// while the About / licenses pages are up so a stray press can't start a match
    /// behind them.
    func remotePlayPause() { if licenses.isOpen || about.isOpen { return }; coordinator?.remotePlayPause() }

    // While the licenses page is up the d-pad scrolls it instead of moving focus;
    // About is a single screen, so the d-pad does nothing there.
    func remoteLeft() { if licenses.isOpen || about.isOpen { return }; moveFocus(dRow: 0, dCol: -1) }
    func remoteRight() { if licenses.isOpen || about.isOpen { return }; moveFocus(dRow: 0, dCol: 1) }
    func remoteUp() { if licenses.isOpen { licenses.scroll(pages: -1); return }; if about.isOpen { return }; moveFocus(dRow: -1, dCol: 0) }
    func remoteDown() { if licenses.isOpen { licenses.scroll(pages: 1); return }; if about.isOpen { return }; moveFocus(dRow: 1, dCol: 0) }

    /// Menu button: steps back one level (licenses -> About -> lobby); else
    /// pause/resume during a game or the 3-2-1 countdown; returns false otherwise so
    /// the system handles Menu normally (exit at the top level).
    func remoteMenu() -> Bool {
        if licenses.isOpen { closeLicenses(); return true }
        if about.isOpen { closeAbout(); return true }
        guard let c = coordinator, c.state == .playing || c.state == .countdown else { return false }
        c.remoteTogglePause()
        return true
    }

    private func openAbout() {
        about.configure(size: size, playRect: playRect)
        about.open()
    }

    private func closeAbout() { about.close() }

    private func openLicenses() {
        licenses.configure(size: size, playRect: playRect)
        licenses.open()
    }

    private func closeLicenses() { licenses.close() }

    func showResults(_ results: [[String: Any]]) {
        buildResults(results)
    }

    func playCountdownBeep(go: Bool) { music.playBeep(go: go) }
    func startMusic() { music.start() }
    func stopMusic() { music.stop() }
    func pauseMusic() { music.pause() }
    func resumeMusic() { music.resume() }

    // MARK: - Match timer

    private func updateTimer(elapsedMs: Double) {
        let total = Int(elapsedMs / 1000)
        let str = String(format: "%02d:%02d", total / 60, total % 60)
        // Fixed size relative to scene height, not cell size, so the clock reads
        // the same regardless of board count and matches the web/Android renderers.
        let fs = max(24, min(size.height * 0.04, 60))
        // The text changes once a second; skip the per-frame glyph
        // re-rasterization (setStyledText re-runs layout + texture upload)
        // unless something that feeds the render actually changed.
        let key = "\(str)|\(fs)|\(currentPlayerCount)"
        if key == lastTimerKey && !timerNode.isHidden { return }
        lastTimerKey = key
        let chars = Array(str)
        // Fixed per-glyph advances (web drawTimer): digits share a width, the colon
        // is narrower, so nothing shifts as the seconds tick.
        let digitAdvance = fs * 0.92, colonAdvance = fs * 0.52
        while timerGlyphs.count < chars.count {
            let l = SKLabelNode()
            l.verticalAlignmentMode = .top
            l.horizontalAlignmentMode = .center
            timerNode.addChild(l)
            timerGlyphs.append(l)
        }
        for (i, l) in timerGlyphs.enumerated() { l.isHidden = i >= chars.count }
        var advances: [CGFloat] = []
        var totalW: CGFloat = 0
        for c in chars { let a = (c == ":") ? colonAdvance : digitAdvance; advances.append(a); totalW += a }
        var cursor: CGFloat = 0
        for (i, c) in chars.enumerated() {
            let l = timerGlyphs[i]
            l.setStyledText(String(c), font: AppFont.name, size: fs, color: UIColor(white: 1, alpha: 0.6), tracking: 0)
            l.position = CGPoint(x: cursor + advances[i] / 2, y: 0)   // web charX = cursor + advance/2
            cursor += advances[i]
        }
        timerNode.isHidden = false
        let topY = playRect.maxY - fs * 0.6
        // Odd board counts: a centered timer overlaps the middle board's stats, so
        // anchor it to the left edge instead (matches the web).
        if currentPlayerCount % 2 == 1 {
            timerNode.position = CGPoint(x: playRect.minX + fs * 0.3, y: topY)
        } else {
            timerNode.position = CGPoint(x: playRect.midX - totalW / 2, y: topY)
        }
    }

    // MARK: - Countdown overlay

    private func buildCountdownOverlay() {
        // Below the pause overlay (90): if a pause ever coincides with a frozen
        // countdown number, the pause modal must sit on top.
        countdownLayer.zPosition = 80
        countdownLayer.isHidden = true
        addChild(countdownLayer)

        countdownDim.path = CGPath(rect: CGRect(origin: .zero, size: size), transform: nil)
        // Scrim matching the web #countdown-overlay: rgba(bg-primary, 0.85) under
        // the radial accent glow (the empty wells stay faintly visible behind it).
        countdownDim.fillColor = UIColor(Theme.bgPrimary, alpha: 0.85)
        countdownDim.strokeColor = .clear
        countdownLayer.addChild(countdownDim)

        // Soft red radial glow behind the number (web radial-gradient tint).
        let glowD = min(size.width, size.height) * 0.7
        let glow = Self.makeGlow(diameter: glowD, color: SKTheme.accentPrimary, centerAlpha: 0.08)
        glow.position = CGPoint(x: size.width / 2, y: size.height / 2)
        countdownLayer.addChild(glow)

        countdownNumber.fontName = AppFont.black
        countdownNumber.fontSize = min(size.height * 0.15, 224)   // web clamp(6rem,15vh,14rem)
        countdownNumber.fontColor = SKTheme.accentPrimary
        countdownNumber.verticalAlignmentMode = .center
        countdownNumber.horizontalAlignmentMode = .center
        countdownNumber.position = CGPoint(x: size.width / 2, y: size.height / 2)
        countdownLayer.addChild(countdownNumber)
    }

    /// A soft radial glow (centerAlpha at the center → transparent at the edge),
    /// computed per-pixel by a shader rather than baked into a texture. A baked
    /// gradient has to be magnified to full-screen, which turns CoreGraphics' fine
    /// anti-band dither into coarse mottling ("dithering gone mad"); drawing it in a
    /// shader runs at native resolution (no magnification, no visible grain) and adds
    /// a ±0.5-LSB ordered dither so the very shallow ramp stays band-free on the dark
    /// background. Color + center alpha are constant per glow, so they are baked into
    /// the source string (no per-node uniforms needed).
    private static func makeGlow(diameter d: CGFloat, color: UIColor, centerAlpha: CGFloat) -> SKSpriteNode {
        let node = SKSpriteNode(texture: Self.glowUnit)
        node.size = CGSize(width: d, height: d)
        node.shader = Self.glowShader(color: color, centerAlpha: centerAlpha)
        return node
    }

    private static func glowShader(color: UIColor, centerAlpha: CGFloat) -> SKShader {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        color.getRed(&r, green: &g, blue: &b, alpha: &a)
        func f(_ v: CGFloat) -> String { String(format: "%.6f", Double(v)) }
        // v_tex_coord spans 0..1 across the sprite; center at 0.5. The ramp is linear
        // in radius (matching the old CGGradient), zero past the inscribed circle.
        // gl_FragColor is premultiplied (SpriteKit's .alpha blend expects that).
        let src = """
        void main() {
            vec2 p = (v_tex_coord - 0.5) * 2.0;
            float alpha = \(f(centerAlpha)) * clamp(1.0 - length(p), 0.0, 1.0);
            float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
            alpha = max(0.0, alpha + (n - 0.5) * 0.003921569);
            gl_FragColor = vec4(\(f(r)), \(f(g)), \(f(b)), 1.0) * alpha;
        }
        """
        return SKShader(source: src)
    }

    /// Opaque 2×2 white stand-in so the glow sprite has a texture to give the shader a
    /// `v_tex_coord`; the shader never samples it (it computes the color from scratch).
    private static let glowUnit: SKTexture = {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 2, height: 2))
        let image = renderer.image { ctx in UIColor.white.setFill(); ctx.fill(CGRect(x: 0, y: 0, width: 2, height: 2)) }
        return SKTexture(image: image)
    }()

    private func buildPauseOverlay() {
        pauseLayer.zPosition = 90
        pauseLayer.isHidden = true
        addChild(pauseLayer)

        pauseDim.path = CGPath(rect: CGRect(origin: .zero, size: size), transform: nil)
        pauseDim.fillColor = UIColor(Theme.bgPrimary, alpha: 0.88)   // --overlay-bg
        pauseDim.strokeColor = .clear
        pauseLayer.addChild(pauseDim)

        pauseTitle.verticalAlignmentMode = .center
        pauseTitle.horizontalAlignmentMode = .center
        // Explicit z above the dim: ignoresSiblingOrder makes equal-z sibling
        // order undefined, so content at the scrim's z0 could draw behind it.
        pauseTitle.zPosition = 1
        pauseTitle.setStyledText(tr("paused"), font: AppFont.brandExtraBold, size: min(size.height * 0.04, 56),
                                 color: SKTheme.textPrimary(), tracking: 0.15)
        pauseLayer.addChild(pauseTitle)
    }

    // MARK: - Display-connection overlay (relay reconnecting / lost)

    private func buildConnectionOverlay() {
        connLayer.zPosition = 130   // above the pause (90) and countdown (80) overlays
        connLayer.isHidden = true
        addChild(connLayer)

        connDim.path = CGPath(rect: CGRect(origin: .zero, size: size), transform: nil)
        connDim.fillColor = UIColor(Theme.bgPrimary, alpha: 0.88)   // --overlay-bg (web .game-overlay)
        connDim.strokeColor = .clear
        connLayer.addChild(connDim)

        for label in [connHeading, connStatus] {
            label.verticalAlignmentMode = .center
            label.horizontalAlignmentMode = .center
            label.zPosition = 1
            connLayer.addChild(label)
        }
    }

    /// Show the full-screen overlay for the DISPLAY's own relay link. While
    /// reconnecting it is informational (auto-retry); once given up (closed) it
    /// offers a focusable RECONNECT. A failed first-launch create drives the same
    /// overlay as a lost room (RECONNECTING → DISCONNECTED). All strings mirror
    /// the web overlay.
    func showConnectionOverlay(reconnecting: Bool, allowReconnect: Bool = true) {
        // Stash the menu behind the overlay so its Select doesn't reach the screen
        // underneath (e.g. PLAY AGAIN during a results-screen blip); restored on hide.
        if savedMenuRows == nil { savedMenuRows = menuRows; savedFocusRC = focusRC }
        connLayer.isHidden = false
        connDim.path = CGPath(rect: CGRect(origin: .zero, size: size), transform: nil)
        let cx = playRect.midX, cy = playRect.midY
        let heading = reconnecting ? tr("reconnecting") : tr("disconnected")
        connHeading.setStyledText(heading,
                                  font: AppFont.brandExtraBold, size: min(size.height * 0.045, 64),
                                  color: SKTheme.textPrimary(), tracking: 0.12)
        connHeading.position = CGPoint(x: cx, y: cy + playRect.height * (reconnecting ? 0.04 : 0.05))
        // Web shows the status line only while reconnecting; the lost state is
        // just heading + RECONNECT. Paint the attempt counter directly when it's
        // already known (onReconnecting fires before this on .main) so the count
        // shows at once — "connection lost" is only the pre-first-tick fallback.
        connStatus.isHidden = !reconnecting
        let status = connAttempt > 0
            ? tr("attempt_n_of_m", ["attempt": connAttempt, "max": connMax])
            : tr("connection_lost")
        connStatus.setStyledText(status, font: AppFont.brandBold, size: min(size.height * 0.022, 28),
                                 color: SKTheme.textSecondary, tracking: 0.08)
        connStatus.position = CGPoint(x: cx, y: connHeading.position.y - playRect.height * 0.08)

        connButton?.removeFromParent(); connButton = nil
        if !reconnecting && allowReconnect {
            let btnH = max(48, playRect.height * 0.075)
            let reconnect = tr("reconnect")
            let probe = SKLabelNode()
            probe.setStyledText(reconnect, font: AppFont.brandBold, size: btnH * 0.36, color: .white, tracking: 0.08)
            let bw = probe.frame.width + min(playRect.width * 0.04, 96) * 2
            let btn = MenuButton(text: reconnect, width: bw, height: btnH, primary: true,
                                 tint: SKTheme.accentPrimary) { [weak self] in
                self?.relay?.reconnectNow(); self?.hideConnectionOverlay()
            }
            // Sit just below the heading (web stacks them tightly); symmetric with the
            // heading's +0.05 keeps the heading+button group centered on the board.
            btn.position = CGPoint(x: cx, y: cy - playRect.height * 0.05)
            btn.zPosition = 1   // above connDim, like the heading/status labels
            connLayer.addChild(btn)
            connButton = btn
            applyMenu([[btn]])
        } else {
            applyMenu([])   // informational / terminal: block input to the screen behind
        }
    }

    /// Update the reconnect status line to "Attempt N of M" (web parity); the
    /// static "Connection lost" is the fallback shown until the first retry tick.
    /// The count is stashed even when the overlay isn't up yet so a subsequent
    /// showConnectionOverlay paints it immediately (no "connection lost" flash).
    func updateReconnectStatus(attempt: Int, max: Int) {
        connAttempt = attempt; connMax = max
        guard !connLayer.isHidden, !connStatus.isHidden else { return }
        connStatus.setStyledText(tr("attempt_n_of_m", ["attempt": attempt, "max": max]),
                                 font: AppFont.brandBold, size: min(size.height * 0.022, 28),
                                 color: SKTheme.textSecondary, tracking: 0.08)
    }

    func hideConnectionOverlay() {
        connLayer.isHidden = true
        connAttempt = 0; connMax = 0   // next disconnect counts fresh from attempt 1
        connButton?.removeFromParent(); connButton = nil
        if let rows = savedMenuRows {
            savedMenuRows = nil   // clear FIRST so this install isn't diverted back into the stash
            applyMenu(rows, focus: (savedFocusRC.r, savedFocusRC.c))
        }
    }

    /// App is backgrounding/terminating: tell controllers the display is gone.
    func notifyDisplayClosing() { coordinator?.displayWillClose() }

    // MARK: - Board layout

    private func ensureBoards(for snapshot: GameSnapshot) {
        // Rebuild when the actual set of player ids changes, not just the count: a
        // new match with the same player count but a different roster (or a
        // mid-game rekey) must rebuild, or renderSnapshot's boardNodes[p.id] lookups
        // miss the new ids and the previous game's boards stay frozen on screen.
        let ids = snapshot.players.map { $0.id }
        guard ids != lastBoardIds else { return }
        lastBoardIds = ids
        currentPlayerCount = snapshot.players.count
        gameLayer.removeChildren(in: boardNodes.values.map { $0 })
        boardNodes.removeAll()

        let layout = LayoutEngine.layout(playerCount: snapshot.players.count,
                                         viewportW: playRect.width, viewportH: playRect.height)
        for (i, placement) in layout.placements.enumerated() where i < snapshot.players.count {
            let player = snapshot.players[i]
            let rec = coordinator.flow.player(player.id)
            let node = BoardNode(geometry: layout.geometry,
                                 colorSlot: rec?.colorSlot ?? i,
                                 name: rec?.playerName ?? "P\(player.id)")
            // Place within the title-safe rect. Convert the Y-down top-left
            // placement origin to a Y-up scene position inset by the safe area.
            node.position = CGPoint(x: playRect.minX + placement.originX,
                                    y: playRect.maxY - placement.originY - layout.geometry.boardHeight)
            gameLayer.addChild(node)
            boardNodes[player.id] = node
        }
    }

    // MARK: - Lobby

    private var lobbyRoom: String?
    // Latest reconnect attempt/max, stashed from onReconnecting so the overlay can
    // paint "Attempt N of M" the moment it appears (no "connection lost" flash).
    private var connAttempt = 0
    private var connMax = 0
    private var lobbyJoinURL: String?
    // The QR payload. In production it equals lobbyJoinURL (the QR encodes the join
    // URL); the screen-gallery JOIN fixture makes them differ (displayed code vs QR
    // target), so the QR is threaded separately from the shown host/code.
    private var lobbyQRText: String?
    private var lobbyEntranceDone = false   // entrance anim plays once per lobby entry

    private func buildLobby(room: String, joinURL: String, players: [PlayerRecord], host: Int?) {
        lobbyRoom = room
        lobbyJoinURL = joinURL
        lobbyBg.configure(size: size)
        lobbyContent.removeAllChildren()
        // Build in play-rect-local coordinates (offset to the safe area).
        lobbyContent.position = CGPoint(x: playRect.minX, y: playRect.minY)

        let W = playRect.width, H = playRect.height
        let margin = H * 0.05
        let animateEntrance = !lobbyEntranceDone
        lobbyEntranceDone = true

        // --- Title lockup (baked triad mark + HEX STACKER wordmark + PARTY sub),
        // mirroring the web display lobby's .brand-lockup--row. Sized to ~7.5% of
        // the play height to match the web wordmark (clamp(1.6rem, 7vmin, 5rem)).
        let mainSize = max(44, min(H * 0.075, 84))
        let titleImg = TitleTexture.make(mainSize: mainSize)
        let title = SKSpriteNode(texture: SKTexture(image: titleImg))
        title.size = titleImg.size
        // The sprite is center-anchored, so centering its (now wider) texture on
        // W/2 centers the whole lockup; the -0.4em nudge is the row variant's
        // optical-centering shift (web .brand-lockup--row left: -0.4em).
        title.position = CGPoint(x: W / 2 - mainSize * 0.4, y: H - margin - titleImg.size.height / 2)
        lobbyContent.addChild(title)
        if animateEntrance { playEntrance(title, fromDy: 16, delay: 0) }   // fadeDown

        // --- Bottom: Start button (focusable; host-tinted), sized to its text
        // plus padding (web .btn is content-width, not a fixed wide pill).
        // Lifted off the bottom edge so the button, the credit line below it,
        // and the screen edge each get breathing room instead of stacking tight.
        // Same height as the overlay action buttons (pause/results/reconnect all
        // use H*0.075) so every button on tvOS is a uniform height across screens.
        let pillH = max(48, H * 0.075)
        // Start sits lifted off the bottom title-safe edge; the About entry is the
        // top-right ⓘ (below), not a footer link, so the bottom band holds Start alone.
        let pillY = margin + pillH / 2
        let hasPlayers = !players.isEmpty
        let hostColor = host.flatMap { h in players.first { $0.peerIndex == h }?.colorSlot }
            .map { SKTheme.player(slot: $0) }
        let startText = hasPlayers
            ? trUpper("start_n_players", ["count": players.count])
            : trUpper("waiting_for_players")
        let startProbe = SKLabelNode()
        startProbe.setStyledText(startText, font: AppFont.brandBold, size: pillH * 0.36, color: .white, tracking: 0.08)
        let startW = startProbe.frame.width + min(W * 0.04, 96) * 2   // web padding clamp(2rem, 4vw, 6rem)
        let startBtn = MenuButton(
            text: startText,
            width: startW, height: pillH,
            primary: true, tint: hostColor ?? SKTheme.accentPrimary, enabled: hasPlayers
        ) { [weak self] in self?.coordinator?.remoteStartMatch() }
        startBtn.position = CGPoint(x: W / 2, y: pillY)
        lobbyContent.addChild(startBtn)
        // --- Top-right ⓘ: the entry to the About screen (Privacy / Imprint QR + Open
        // Source Licenses). Icon-only, so there is no TV-only string; the music
        // attribution and license text live inside the licenses screen it drills into.
        let infoD = max(40, min(H * 0.07, 64))
        let infoBtn = InfoButton(diameter: infoD) { [weak self] in self?.openAbout() }
        infoBtn.position = CGPoint(x: W - infoD / 2 - margin * 0.2, y: H - infoD / 2 - margin * 0.2)
        lobbyContent.addChild(infoBtn)

        // Only take over the focus menu when the lobby is the active screen.
        // updateLobby() also runs (for the hidden lobby) on roster/name/color changes
        // during RESULTS — without this guard it would clobber the results menu and
        // break its Left/Right navigation. The ⓘ is row 0 (d-pad Up from Start reaches
        // it; it is the only focusable while Start is disabled waiting for players),
        // Start is row 1 and the default focus. Don't seat focus on an empty lobby:
        // with Start disabled, autoFocus would land on the ⓘ, which reads as odd
        // before anyone has joined — the first d-pad press picks it up.
        if coordinator?.state == .lobby {
            setMenu([[infoBtn], [startBtn]], focus: hasPlayers ? (1, 0) : nil, autoFocus: hasPlayers)
        }
        if animateEntrance {
            playEntrance(startBtn, fromDy: -16, delay: 0.45)   // fadeUp
            infoBtn.alpha = 0
            infoBtn.run(.sequence([.wait(forDuration: 0.6), .fadeIn(withDuration: 0.5)]))
        }

        // --- Body band: QR card (left) + player grid (right) as a centered row,
        // vertically centered against each other (web #lobby-body: flex row,
        // align-items center). Sizes are CAPPED like the web clamps (a touch
        // larger for TV) so cards stay one size for any player count — just more
        // columns. The QR is sized independently (big + scannable), not shrunk to
        // the grid height.
        let titleBottom = H - margin - titleImg.size.height
        let bodyTop = titleBottom - margin * 0.5
        let bodyBottom = pillY + pillH / 2 + margin * 0.5
        let bodyMidY = (bodyTop + bodyBottom) / 2
        let bandH = bodyTop - bodyBottom
        let vmin = min(size.width, size.height)

        let sorted = players.sorted { $0.joinedAt < $1.joinedAt }
        // Show 4 placeholder slots by default (8 players are still allowed — the
        // grid grows to a 4-wide row as they join). tvOS reports a 1920pt logical
        // screen regardless of 1080p/4K, which is below the web's 2400px "show 8"
        // threshold, so 4 is the faithful default and reads less sparse on a TV.
        let visibleSlots = min(max(4, players.count), EngineConstants.maxPlayers)
        let cols = visibleSlots > 4 ? 4 : 2
        let rows = Int(ceil(Double(visibleSlots) / Double(cols)))
        let cardGap = min(vmin * 0.016, 18)
        let gapMid = min(vmin * 0.032, 40)

        var cardW = min(vmin * 0.255, 290)            // web card clamp(150, 24vmin, 280)
        var qrW = min(vmin * 0.38, 380)               // web QR  clamp(180, 36vmin, 360)
        qrW = min(qrW, bandH * 0.98 / Self.qrAspect)  // keep the QR card within the band height
        // Horizontal fit: shrink proportionally if the widest row would overflow.
        let rowWidth = qrW + gapMid + CGFloat(cols) * cardW + CGFloat(cols - 1) * cardGap
        let budget = W * 0.96
        if rowWidth > budget { let s = budget / rowWidth; cardW *= s; qrW *= s }

        let cardH = cardW * 0.5
        let gridH = CGFloat(rows) * cardH + CGFloat(rows - 1) * cardGap
        let gridW = CGFloat(cols) * cardW + CGFloat(cols - 1) * cardGap

        let totalW = qrW + gapMid + gridW
        let startX = (W - totalW) / 2

        let qrCard = buildQRCard(joinURL: joinURL, width: qrW, center: CGPoint(x: startX + qrW / 2, y: bodyMidY))
        lobbyContent.addChild(qrCard)
        if animateEntrance { playEntrance(qrCard, fromDy: -16, delay: 0.15) }   // fadeUp

        let gridLeftX = startX + qrW + gapMid
        let gridTopY = bodyMidY + gridH / 2

        var present: Set<Int> = []
        for slot in 0..<visibleSlots {
            let c = slot % cols, r = slot / cols
            let cx = gridLeftX + CGFloat(c) * (cardW + cardGap) + cardW / 2
            let cy = gridTopY - CGFloat(r) * (cardH + cardGap) - cardH / 2
            let player = slot < sorted.count ? sorted[slot] : nil
            let card = buildPlayerCard(player: player, slotIndex: slot, w: cardW, h: cardH)
            card.position = CGPoint(x: cx, y: cy)
            lobbyContent.addChild(card)
            if let p = player {
                present.insert(p.peerIndex)
                if !lobbyKnownPlayers.contains(p.peerIndex) {
                    card.setScale(0.6); card.alpha = 0
                    card.run(.group([.fadeIn(withDuration: 0.2),
                                     .sequence([.scale(to: 1.08, duration: 0.27),
                                                .scale(to: 0.96, duration: 0.09),
                                                .scale(to: 1.0, duration: 0.09)])]))
                }
            }
        }
        lobbyKnownPlayers = present
    }

    private func roundedRect(_ rect: CGRect, radius: CGFloat) -> CGPath {
        UIBezierPath(roundedRect: rect, cornerRadius: radius).cgPath
    }

    /// Fade + slide a node into place (web fadeDown/fadeUp entrance). `fromDy` is
    /// the starting vertical offset (positive = starts above and drops).
    private func playEntrance(_ node: SKNode, fromDy: CGFloat, delay: TimeInterval) {
        node.alpha = 0
        node.position.y += fromDy
        let fade = SKAction.fadeIn(withDuration: 0.5); fade.timingMode = .easeOut
        let move = SKAction.moveBy(x: 0, y: -fromDy, duration: 0.5); move.timingMode = .easeOut
        node.run(.sequence([.wait(forDuration: delay), .group([fade, move])]))
    }

    // QR card height : width. Mostly a big QR square with a compact code below
    // (matches the web's near-square QR card, not a tall narrow one).
    static let qrAspect: CGFloat = 1.32

    private func buildQRCard(joinURL: String, width w: CGFloat, center: CGPoint) -> SKNode {
        let node = SKNode()
        node.position = center
        let h = w * Self.qrAspect
        let card = SKShapeNode(path: roundedRect(CGRect(x: -w / 2, y: -h / 2, width: w, height: h), radius: w * 0.09))
        card.fillColor = SKTheme.bgCard
        card.strokeColor = SKTheme.border
        card.lineWidth = 1
        node.addChild(card)

        // Equal padding top + bottom; a large QR square up top, the join-URL pill
        // fills the remaining height down to the bottom padding (no empty gap).
        let pad = w * 0.06
        let qrSide = w - pad * 2
        let qrCenterY = h / 2 - pad - qrSide / 2

        let qrBg = SKShapeNode(path: roundedRect(CGRect(x: -qrSide / 2, y: qrCenterY - qrSide / 2,
                                                        width: qrSide, height: qrSide), radius: w * 0.06))
        qrBg.fillColor = .white
        qrBg.strokeColor = .clear
        node.addChild(qrBg)
        // The QR encodes lobbyQRText (== joinURL in production; a distinct target in
        // the gallery JOIN fixture), while the pill below shows the joinURL host/code.
        // Empty payload = no room yet (the pre-room / create-failure lobby): leave the
        // white square blank, matching the web lobby's empty QR canvas.
        let qrPayload = lobbyQRText ?? joinURL
        if !qrPayload.isEmpty, let qr = QRCode.image(for: qrPayload) {
            let sprite = SKSpriteNode(texture: SKTexture(image: qr))
            let inset = qrSide * 0.92
            sprite.size = CGSize(width: inset, height: inset)
            sprite.position = CGPoint(x: 0, y: qrCenterY)
            node.addChild(sprite)
        }

        let labelY = qrCenterY - qrSide / 2 - w * 0.075
        let scan = SKLabelNode()
        scan.verticalAlignmentMode = .center
        scan.zPosition = 1
        // display.css #qr-label clamp(11px,1.8vmin,15px) — 15px cap at 1080p.
        scan.setStyledText(trUpper("scan_to_join"), font: AppFont.brandBold, size: min(w * 0.068, 15),
                           color: SKTheme.textFaint, tracking: 0.16)
        scan.position = CGPoint(x: 0, y: labelY)
        node.addChild(scan)

        // Join URL on a dark pill (web #join-url background rgba(0,0,0,0.22)):
        // host line (muted) + room code (accent, heavy). The pill fills from
        // below SCAN to the bottom padding so the card isn't bottom-empty.
        let (hostText, codeText) = Self.splitJoinURL(joinURL)
        let pillTop = labelY - w * 0.06
        let pillBottom = -h / 2 + pad
        let pillH = pillTop - pillBottom
        let pillCenterY = (pillTop + pillBottom) / 2
        let pill = SKShapeNode(path: roundedRect(
            CGRect(x: -qrSide / 2, y: pillBottom, width: qrSide, height: pillH), radius: w * 0.05))
        pill.fillColor = UIColor(white: 0, alpha: 0.22)
        pill.strokeColor = .clear
        pill.zPosition = 0.5
        node.addChild(pill)

        let hostLabel = SKLabelNode()
        hostLabel.verticalAlignmentMode = .center
        hostLabel.zPosition = 1
        hostLabel.setStyledText(hostText, font: AppFont.semibold, size: w * 0.05,
                                color: SKTheme.textSecondary, tracking: 0.04)
        hostLabel.position = CGPoint(x: 0, y: pillCenterY + pillH * 0.24)
        node.addChild(hostLabel)

        let codeLabel = SKLabelNode()
        codeLabel.verticalAlignmentMode = .center
        codeLabel.zPosition = 1
        codeLabel.setStyledText(codeText, font: AppFont.black, size: w * 0.09,
                                color: SKTheme.accentSecondary, tracking: 0.16)
        codeLabel.position = CGPoint(x: 0, y: pillCenterY - pillH * 0.18)
        node.addChild(codeLabel)

        return node
    }

    /// "https://host/CODE#instance" -> ("host/", "CODE"). Mirrors renderJoinUrl.
    static func splitJoinURL(_ url: String) -> (host: String, code: String) {
        guard let u = URL(string: url), let host = u.host else { return ("", url) }
        let code = u.path.replacingOccurrences(of: "/", with: "")
        return (host + "/", code.isEmpty ? url : code)
    }

    private func buildPlayerCard(player: PlayerRecord?, slotIndex: Int, w: CGFloat, h: CGFloat) -> SKNode {
        let node = SKNode()
        let rect = CGRect(x: -w / 2, y: -h / 2, width: w, height: h)
        let card = SKShapeNode(path: roundedRect(rect, radius: min(w, h) * 0.12))
        let color = player.map { SKTheme.player(slot: $0.colorSlot) }

        if let color {
            card.fillColor = SKTheme.bgCard
            card.strokeColor = color
            card.lineWidth = 2
        } else {
            card.fillColor = .clear
            card.strokeColor = SKTheme.textSecondary
            card.lineWidth = 2
            // Dashed border for empty slots (matches .player-card.empty).
            if let dashed = card.path?.copy(dashingWithPhase: 0, lengths: [h * 0.10, h * 0.07]) {
                card.path = dashed
            }
        }
        node.addChild(card)

        // Top half: name (web .player-name: weight 800, 0.04em tracking). Fixed
        // size + ellipsis truncation (never scaled), so every chip matches.
        // display.css .player-card .identity-name clamp(1.5rem,4.5vmin,2.4rem):
        // the 10-foot override caps at 38.4px on a 1080p TV.
        let nameSize = min(h * 0.37, 38.4)
        let nameColor = color ?? SKTheme.textSecondary
        let name = SKLabelNode()
        name.verticalAlignmentMode = .center
        name.horizontalAlignmentMode = .center
        name.position = CGPoint(x: 0, y: h * 0.25)
        var nameText = player?.playerName ?? "P\(slotIndex + 1)"
        name.setStyledText(nameText, font: AppFont.brandExtraBold, size: nameSize, color: nameColor, tracking: 0.04)
        while name.frame.width > w * 0.86 && nameText.count > 1 {
            nameText = String(nameText.dropLast())
            name.setStyledText(nameText + "…", font: AppFont.brandExtraBold, size: nameSize, color: nameColor, tracking: 0.04)
        }
        node.addChild(name)

        // Divider.
        let divider = SKShapeNode(path: {
            let p = CGMutablePath()
            p.move(to: CGPoint(x: -w * 0.4, y: 0)); p.addLine(to: CGPoint(x: w * 0.4, y: 0)); return p
        }())
        divider.strokeColor = (color == nil) ? SKTheme.textSecondary : SKTheme.glass
        divider.lineWidth = 1
        node.addChild(divider)

        // Bottom half: "LEVEL N" centered as a group (label muted, value bright).
        let levelGroup = SKNode()
        levelGroup.position = CGPoint(x: 0, y: -h * 0.25)
        let heading = SKLabelNode()
        heading.verticalAlignmentMode = .center
        heading.horizontalAlignmentMode = .center
        // display.css .card-level__heading clamp(1rem,2.6vmin,1.5rem) — 24px cap.
        heading.setStyledText(trUpper("level_heading"), font: AppFont.brandBold, size: min(h * 0.19, 24),
                              color: SKTheme.textSecondary, tracking: 0.1)
        let value = SKLabelNode()
        value.verticalAlignmentMode = .center
        value.horizontalAlignmentMode = .center
        value.setStyledText(player.map { "\($0.startLevel)" } ?? "—", font: AppFont.brandExtraBold,
                            size: min(h * 0.225, 24), color: player == nil ? SKTheme.textSecondary : SKTheme.textPrimary(), tracking: 0)
        let groupGap = h * 0.10
        let groupW = heading.frame.width + groupGap + value.frame.width
        heading.position = CGPoint(x: -groupW / 2 + heading.frame.width / 2, y: 0)
        value.position = CGPoint(x: groupW / 2 - value.frame.width / 2, y: 0)
        levelGroup.addChild(heading)
        levelGroup.addChild(value)
        if player == nil { levelGroup.alpha = 0.45 }
        node.addChild(levelGroup)
        return node
    }

    // MARK: - Results

    private func buildResults(_ results: [[String: Any]]) {
        resultsLayer.removeAllChildren()
        resultsLayer.position = CGPoint(x: playRect.minX, y: playRect.minY)
        let W = playRect.width, H = playRect.height

        let sorted = results.sorted { (a, b) in (a["rank"] as? Int ?? 999) < (b["rank"] as? Int ?? 999) }

        // Web --overlay-bg: a brand-plum tint (bgPrimary @0.88) over the blurred
        // frozen boards (the gameEffect blur supplies the frosted backdrop).
        // Oversized + behind everything; resultsLayer is offset to the play rect,
        // so center it on the play rect (≈ screen centre).
        let backdrop = SKSpriteNode(color: UIColor(Theme.bgPrimary, alpha: 0.88),
                                    size: CGSize(width: size.width * 1.5, height: size.height * 1.5))
        backdrop.position = CGPoint(x: W / 2, y: H / 2)
        backdrop.zPosition = -1
        resultsLayer.addChild(backdrop)

        // Winner glow: one soft radial over the tint (web --winner-glow).
        if let slot = sorted.first?["colorIndex"] as? Int {
            // Match web's radius (0.6 × distance to the farthest corner from the 50%/30%
            // center) and alpha (0.08) so the glow is as contained + faint as the browser's,
            // not a broad wash over the whole screen.
            let d = 1.2 * hypot(W / 2, H * 0.7)
            let glow = Self.makeGlow(diameter: d, color: SKTheme.player(slot: slot), centerAlpha: 0.08)
            glow.position = CGPoint(x: W / 2, y: H * 0.70)   // web --winner-glow at 50% 30%
            // Behind the rows + buttons (z0). Without this it shares z0 with them
            // and, under ignoresSiblingOrder, paints OVER the opaque cards — tinting
            // the row backgrounds (and the solo NEW GAME button) warmer/lighter.
            glow.zPosition = -0.5
            resultsLayer.addChild(glow)
        }

        // No heading: the web results screen has no title (and the port mirrors the
        // web copy). The frosted boards + ranked rows carry the screen.
        let solo = sorted.count == 1
        let rowW = min(W * 0.62, 880)   // web #results-list max-width 860px
        // Snug rows like the web/Android list (name + web-scale vertical padding),
        // not the taller block the earlier pass produced.
        let rowH = max(60, H * 0.072)
        let rowGap: CGFloat = 14
        let rowsBlockH = CGFloat(sorted.count) * rowH + CGFloat(max(0, sorted.count - 1)) * rowGap

        // Action-button metrics (needed up-front to balance the group).
        let btnH = max(48, H * 0.075)
        let btnW = max(W * 0.20, btnH * 4.5)
        let gap = W * 0.03

        // Lay the ranked rows + the action buttons out as ONE vertically-centered
        // group (the web #results-screen is a centered flex column with a gap), so
        // a single-player result isn't stranded above buttons pinned to the bottom.
        let groupGap = max(btnH * 0.7, H * 0.06)   // web .screen gap clamp(2rem, 5vh, 4rem)
        let groupH = rowsBlockH + groupGap + btnH
        let groupTop = H / 2 + groupH / 2

        var y = groupTop - rowH / 2
        for (i, res) in sorted.enumerated() {
            let isNew = (res["newPlayer"] as? Bool) ?? false
            let color = (res["colorIndex"] as? Int).map { SKTheme.player(slot: $0) }
            let row = buildResultRow(res, solo: solo, isNew: isNew, color: color, w: rowW, h: rowH)
            row.position = CGPoint(x: W / 2, y: y - 10)
            row.alpha = 0
            let fade = SKAction.fadeIn(withDuration: 0.4); fade.timingMode = .easeOut
            let move = SKAction.moveBy(x: 0, y: 10, duration: 0.4); move.timingMode = .easeOut
            row.run(.sequence([.wait(forDuration: 0.2 + Double(i) * 0.08), .group([fade, move])]))
            resultsLayer.addChild(row)
            y -= rowH + rowGap
        }

        // Action buttons (focusable; also triggerable from a phone). The web
        // never winner-tints the CTA — only the background glow carries color.
        let btnY = groupTop - rowsBlockH - groupGap - btnH / 2
        let playAgain = MenuButton(text: trUpper("play_again"), width: btnW, height: btnH, primary: true,
                                   tint: SKTheme.accentPrimary) { [weak self] in self?.coordinator?.remoteStartMatch() }
        let newGame = MenuButton(text: trUpper("new_game"), width: btnW, height: btnH, primary: false,
                                 tint: SKTheme.accentPrimary) { [weak self] in self?.coordinator?.remoteReturnToLobby() }
        playAgain.position = CGPoint(x: W / 2 - btnW / 2 - gap / 2, y: btnY)
        newGame.position = CGPoint(x: W / 2 + btnW / 2 + gap / 2, y: btnY)
        resultsLayer.addChild(playAgain)
        resultsLayer.addChild(newGame)
        setMenu([[playAgain, newGame]])
        // No anti-misclick gate on the TV (a couch remote, not a phone): the
        // buttons are live immediately and just fade in with the rows.
        for b in [playAgain, newGame] {
            b.alpha = 0
            b.run(.fadeIn(withDuration: 0.4))
        }
    }

    private func buildResultRow(_ res: [String: Any], solo: Bool, isNew: Bool,
                                color: UIColor?, w: CGFloat, h: CGFloat) -> SKNode {
        let node = SKNode()
        let rect = CGRect(x: -w / 2, y: -h / 2, width: w, height: h)

        let card = SKShapeNode(path: roundedRect(rect, radius: 12))
        card.fillColor = SKTheme.bgCard
        card.strokeColor = SKTheme.border          // web keeps the faint base border, even for late joiners
        card.lineWidth = 1
        if isNew, let dashed = card.path?.copy(dashingWithPhase: 0, lengths: [h * 0.12, h * 0.08]) {
            card.path = dashed                      // only the dash pattern marks a late joiner
        }
        if isNew { node.alpha = 0.75 }
        node.addChild(card)

        // One horizontal line: rank | name (left) | stats (right), centered.
        let pad = h * 0.32
        var textLeft = -w / 2 + pad
        if !solo {
            let rank = SKLabelNode(text: isNew ? "–" : "\(res["rank"] as? Int ?? 0)")
            rank.fontName = AppFont.black           // same size as the name; heavier weight reads the rank
            rank.fontSize = h * 0.44
            rank.fontColor = isNew ? SKTheme.textSecondary : (color ?? SKTheme.textSecondary)
            rank.verticalAlignmentMode = .center
            rank.horizontalAlignmentMode = .center
            rank.zPosition = 1
            rank.position = CGPoint(x: -w / 2 + pad + h * 0.22, y: 0)
            node.addChild(rank)
            textLeft = -w / 2 + pad + h * 0.7
        }

        let name = SKLabelNode(text: (res["playerName"] as? String) ?? tr("player"))
        name.fontName = AppFont.brandBold
        name.fontSize = h * 0.44
        name.fontColor = color ?? SKTheme.textSecondary   // web fallback for unnamed players
        name.verticalAlignmentMode = .center
        name.horizontalAlignmentMode = .left
        name.zPosition = 1
        name.position = CGPoint(x: textLeft, y: 0)
        node.addChild(name)

        let statsText: String
        if isNew {
            statsText = tr("new_player")
        } else {
            let n = res["lines"] as? Int ?? 0
            statsText = "\(tr("n_lines", ["count": n]))   \(tr("level_n", ["level": res["level"] as? Int ?? 1]))"
        }
        // Web's .result-stats has no font-family override, so it inherits the plain
        // system-ui font (not Orbitron); match that with the tvOS system font.
        let stats = SKLabelNode()
        stats.attributedText = NSAttributedString(string: statsText, attributes: [
            .font: UIFont.systemFont(ofSize: h * 0.38, weight: .medium),   // web stats:name ratio (2.6vh : 3vh)
            .foregroundColor: SKTheme.textSecondary,
        ])
        stats.verticalAlignmentMode = .center
        stats.horizontalAlignmentMode = .right
        stats.zPosition = 1
        stats.position = CGPoint(x: w / 2 - pad, y: 0)
        node.addChild(stats)

        return node
    }

    // MARK: - Visual-parity capture

    /// Render the shared visual-parity fixture (one board, top-left, cellSize 40)
    /// so the native pixels can be compared to the web canvas render.
    private func renderStaticFixture() {
        let geo = HexGeometry(cellSize: VisualParityFixture.cellSize)
        let node = BoardNode(geometry: geo, colorSlot: 0, name: "", hudless: true)
        node.position = CGPoint(x: 0, y: size.height - CGFloat(geo.boardHeight))
        gameLayer.addChild(node)
        node.update(with: VisualParityFixture.snapshot())
        showScreen(.game)
    }
}
