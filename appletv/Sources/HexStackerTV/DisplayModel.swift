import SwiftUI
import SpriteKit
import AVFoundation
import HexStackerKit

/// The display "shell": owns the relay client, the DisplayCoordinator, the
/// music player and the SpriteKit board scene; implements DisplayOutput by
/// folding chrome callbacks into the published `state` (rendered by
/// DisplayChromeView) and forwarding board/audio callbacks directly. Mirrors
/// the Android TvDisplayOutput + MainActivity wiring.
final class DisplayModel: ObservableObject {

    @Published private(set) var state = UiModel()
    // Gallery carousel marker (HEXGALLERY): the currently-rendered state's
    // name, read by the UI test through the accessibility bridge. "pending"
    // is a sentinel the test waits past for the first real state.
    @Published private(set) var galleryMarker = "pending"

    // Sized from the screen up front; resizeFill tracks the view thereafter.
    let boardScene = BoardScene(size: UIScreen.main.bounds.size)
    private var relay: RelayClient?
    private var coordinator: DisplayCoordinator?
    private let music = MusicPlayer()

    private(set) var galleryMode = ProcessInfo.processInfo.environment["HEXGALLERY"] != nil
    private var galleryIndex = 0
    private var shotMode = false       // HEXSHOT: render one frozen state, no live tick
    private var relayStarted = false   // false in the offline harness modes

    // A match is starting but the countdown scrim isn't on screen yet: hold
    // the visible screen until the first countdown value arrives, so the
    // outgoing lobby/results and the incoming countdown swap in ONE
    // cross-fade. The web does exactly this (onCountdownDisplay calls
    // showScreen); flipping on showScreen alone left the boards bare for as
    // long as the engine took to boot before the first tick.
    private var pendingGameReveal = false

    // Lobby identity (fed by roomReady, joined with the roster by updateLobby).
    private var room: String?
    private var joinURL: String?
    private var qrText: String?

    // Last relay link state, so appDidBecomeActive can tell a healthy socket
    // from an in-flight reconnect.
    private var linkState: RelayClient.ConnectionState = .idle
    // Whether the resign-active actually backgrounded the app (Home press) rather
    // than a transient overlay (app switcher peek, Siri) that returns to active.
    private var backgroundedSinceResign = false

    // MARK: - Transition tokens (the cross-platform spec)

    static let enterFade = Animation.easeOut(duration: 0.3)
    static let exitFade = Animation.easeIn(duration: 0.2)
    static let resultsFade = Animation.easeOut(duration: 0.5)
    static let countdownExitFade = Animation.easeIn(duration: 0.25)

    // MARK: - Boot

    func start() {
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
        try? AVAudioSession.sharedInstance().setActive(true)
        // Keep the screen awake: this display is driven by the phones, so the TV
        // itself receives no input and tvOS would otherwise start the screensaver
        // over the lobby QR / live game. tvOS restores the idle timer when the app
        // backgrounds, so this is scoped to the foreground session.
        UIApplication.shared.isIdleTimerDisabled = true

        // Capture hook (mirrors HEXSHOT / HEXSNAP): open the licenses page straight
        // away so it can be screenshotted deterministically — the tvOS simulator has
        // no Siri-Remote CLI to navigate to it. Inert without the env var.
        if ProcessInfo.processInfo.environment["HEXLICENSES"] != nil {
            state.showAbout = true
            state.showLicenses = true
        }

        // Visual-parity capture: render the fixed fixture board and stop.
        if ProcessInfo.processInfo.environment["HEXSNAP"] != nil {
            state.screen = .game
            boardScene.renderStaticFixture()
            return
        }

        if galleryMode {
            shotMode = true
            presentGalleryState()
            return
        }
        if let shot = ProcessInfo.processInfo.environment["HEXSHOT"] {
            shotMode = true
            let pc = ProcessInfo.processInfo.environment["HEXPLAYERS"].flatMap { Int($0) } ?? 4
            makeCoordinator(relayBacked: false)
            applyShot(shot, playerCount: pc)
            return
        }

        // Lobby UI verification: populate fake players (no relay) so filled
        // player cards / host tint can be exercised without controllers.
        if ProcessInfo.processInfo.environment["HEXLOBBY"] != nil {
            makeCoordinator(relayBacked: false)
            startTickPump()
            coordinator?.startLobbyDemo(playerCount: 3)
            return
        }

        // Self-playing local game (no relay), for rendering verification. Must
        // NOT call start() — the relay's async onCreated would flip the screen
        // back to the lobby mid-demo.
        if ProcessInfo.processInfo.environment["HEXDEMO"] != nil {
            makeCoordinator(relayBacked: false)
            startTickPump()
            showScreen(.lobby)
            coordinator?.startLocalDemo(playerCount: 2)
            return
        }

        makeCoordinator(relayBacked: true)
        startTickPump()
        coordinator?.start()
        relayStarted = true
        showScreen(.lobby)
        // The waiting-lobby scaffold renders immediately so the create-failure
        // overlay sits on top of the lobby (not a bare background) and there's
        // no empty-screen flash before the room arrives.
        state.lobby = LobbyData()
    }

    private func makeCoordinator(relayBacked: Bool) {
        let relay = RelayClient()
        self.relay = relay
        // Optional WebRTC input fastlane: controller input rides peer-to-peer
        // DataChannels when open, with the relay as signaling + fallback. Built
        // only when the WebRTC framework is linked (canImport); otherwise nil and
        // all input flows over the relay (the v1 behavior).
        let fastlane: InputFastlane?
        #if canImport(LiveKitWebRTC)
        fastlane = WebRTCFastlane.make(stunURL: HexStackerKit.Protocol.stunURL,
                                       sendSignal: { [weak self] idx, data in self?.relay?.sendTo(idx, data) })
        #else
        fastlane = nil
        #endif
        let coordinator = DisplayCoordinator(transport: relay,
                                             engineDirectory: AssetLocator.engineDirectory,
                                             output: self,
                                             fastlane: fastlane)
        self.coordinator = coordinator
        boardScene.rosterLookup = { [weak coordinator] id in
            coordinator?.flow.player(id).map { ($0.colorSlot, $0.playerName) }
        }
        guard relayBacked else { return }

        // The display's own relay link dropping shows a full-screen overlay
        // (distinct from a single controller dropping = per-board QR), AND freezes
        // the simulation so it can't run blind (KO'ing players who can't send
        // input) behind the overlay; reconnecting resumes it.
        relay.onConnectionState = { [weak self] connState in
            guard let self else { return }
            self.linkState = connState
            self.coordinator?.setRelayConnected(connState == .open)
            withAnimation(connState == .open || connState == .connecting || connState == .idle
                          ? Self.exitFade : Self.enterFade) {
                self.state.connection = connState
                if connState == .reconnecting { self.state.reconnectAttempt = 0 }
                if connState == .open { self.state.replaced = false }
            }
            // Any state but .open means the link is (still) down, so the shown lobby
            // QR may be stale (a rejoin can bounce off "Room not found" into a fresh
            // room). Notably .connecting shows no overlay (a foreground rejoin after
            // suspend() must not flash the full DISCONNECTED cover), so the dim is
            // what marks the QR untrusted. .open does NOT clear it — the socket
            // opens before the relay answers the join; only roomReady re-confirms.
            if connState != .open { self.state.qrPending = true }
        }
        // Evicted because another client claimed the "display" slot: reconnecting
        // would start a takeover war, so show a terminal disconnect with no button.
        relay.onReplaced = { [weak self] in
            guard let self else { return }
            self.coordinator?.setRelayConnected(false)
            withAnimation(Self.enterFade) {
                self.state.replaced = true
                self.state.connection = .closed
            }
        }
        // Live "Attempt N of M" on the reconnect overlay (web parity).
        relay.onReconnecting = { [weak self] attempt, max in
            self?.state.reconnectAttempt = attempt
            self?.state.reconnectMax = max
        }
    }

    private func startTickPump() {
        boardScene.onTick = { [weak self] deltaMs in
            self?.coordinator?.tick(deltaMs: deltaMs)
        }
    }

    // MARK: - Intents (remote / focus-engine driven)

    func playAgain() { coordinator?.remoteStartMatch() }
    func newGame() { coordinator?.remoteReturnToLobby() }
    func togglePause() { coordinator?.remoteTogglePause() }
    func toggleMusic() { _ = coordinator?.remoteToggleMute() }

    /// Play/Pause context action (Start / Pause / Continue / Play Again).
    /// Inert while About/Licenses cover the lobby (the button can't start a
    /// match under a legal page) or while the connection overlay is up (it
    /// can't start a match under a frozen, relay-less simulation).
    func playPause() {
        guard !state.showAbout, !state.showLicenses, !state.connectionOverlayUp else { return }
        coordinator?.remotePlayPause()
    }
    func reconnectNow() { relay?.reconnectNow() }
    /// About / Licenses swaps fade like the other screen changes; returning to
    /// the lobby uses the exit fade (the lobby itself re-enters instantly with
    /// its entrance stagger).
    func openLicenses() { withAnimation(Self.enterFade) { state.showLicenses = true } }

    /// Menu button: step back one level; return false at the top level so tvOS
    /// exits the app normally (the caller falls through to the default). Also
    /// declines under the connection overlay — exiting to the home screen there
    /// is safe (backgrounding suspends the socket; the party resumes gracefully).
    func handleMenu() -> Bool {
        guard !state.connectionOverlayUp else { return false }
        if state.showLicenses { withAnimation(Self.exitFade) { state.showLicenses = false }; return true }
        if state.showAbout { withAnimation(Self.exitFade) { state.showAbout = false }; return true }
        if state.screen == .game { coordinator?.remoteTogglePause(); return true }
        return false
    }

    // MARK: - Lobby menu (manual focus)

    // The lobby's two-item menu (START / ⓘ) is driven from the responder
    // chain, not the focus engine (see UiModel.lobbyFocus). Consuming presses
    // here is safe: while About/Licenses or an overlay is up, or on any other
    // screen, these decline and the press stays with the engine.
    private var lobbyMenuActive: Bool {
        state.screen == .lobby && !state.showAbout && !state.showLicenses
            && !state.connectionOverlayUp
    }

    func lobbyMoveFocus(up: Bool) -> Bool {
        guard lobbyMenuActive else { return false }
        state.lobbyFocus = up ? .info : .start
        return true
    }

    func lobbySelect() -> Bool {
        guard lobbyMenuActive else { return false }
        switch state.lobbyFocus {
        case .start:
            // Consume even while disabled (web: a disabled START ignores input).
            if !(state.lobby?.players.isEmpty ?? true) { coordinator?.remoteStartMatch() }
        case .info:
            withAnimation(Self.enterFade) { state.showAbout = true }
        }
        return true
    }

    // MARK: - App lifecycle

    /// App is backgrounding. Don't end the party (backgrounding is recoverable,
    /// unlike the web's pagehide): close the P2P channels and suspend the relay
    /// socket, giving the relay an immediate peer_left(0) so controllers show
    /// their reconnect overlay right away.
    func appDidEnterBackground() {
        backgroundedSinceResign = true
        coordinator?.displayDidEnterBackground()
        guard relayStarted else { return }   // HEXSHOT/HEXLOBBY/HEXDEMO never connect
        relay?.suspend()
    }

    /// App returned to the foreground: rejoin explicitly. If the room survived,
    /// `joined` replays the roster; if the relay retired it, the join answers
    /// "Room not found" and onRelayError opens a fresh room.
    func appWillEnterForeground() {
        guard relayStarted else { return }
        relay?.reconnectNow()
    }

    /// Frames rendered up to resign-active feed the system snapshot — the image
    /// the return transition shows. Dim the QR now so a possibly-stale room code
    /// never presents as live on resume; the happy-path rejoin clears the dim
    /// (roomReady) before the first live frame, making it invisible.
    func appWillResignActive() {
        guard relayStarted else { return }   // gallery/demo harnesses have no room
        state.qrPending = true
    }

    /// Transient resign (no backgrounding): the socket never suspended and the
    /// room is unchanged, so lift the precautionary dim — unless the link is
    /// genuinely down, where roomReady clears it after the reconnect instead.
    func appDidBecomeActive() {
        if !backgroundedSinceResign, linkState == .open { state.qrPending = false }
        backgroundedSinceResign = false
    }

    // MARK: - Gallery (HEXSHOT / HEXGALLERY)

    // Single source of truth for the gallery order (mirrors the `tvos` entries
    // in scripts/gallery/scenarios.json); the UI test reads each state's name
    // back through the accessibility marker.
    static let galleryStates: [(name: String, shot: String, players: Int)] = [
        ("lobby", "lobby", 4),
        ("lobby-2p", "lobby", 2),
        ("lobby-8p", "lobby", 8),
        ("lobby-long-names", "lobby-long", 4),
        ("lobby-empty", "lobby-empty", 0),
        ("countdown", "countdown", 4),
        ("game", "game", 4),
        ("game-lv8", "game-lv8", 4),
        ("game-lv12", "game-lv12", 4),
        ("game-2p", "game-2p", 2),
        ("game-3p", "game-3p", 3),
        ("game-4p", "game-4p", 4),
        ("game-8p", "game-8p", 8),
        ("pause", "pause", 4),
        ("pause-music", "pause-music", 4),
        ("disconnected-controller", "disconnected-controller", 4),
        ("create-error-retry", "create-error-retry", 0),
        ("create-error", "create-error", 0),
        ("reconnecting", "reconnecting", 4),
        ("disconnected-display", "disconnected-display", 4),
        ("results", "results", 4),
        ("results-solo", "results-solo", 1),
        ("about", "about", 0),
        ("licenses", "licenses", 0),
    ]

    /// Advance to the next gallery state (Play/Pause in gallery mode). The marker
    /// keeps reporting the PREVIOUS name until the new state signals ready, so
    /// the UI test reliably waits for a changed value before capturing.
    func advanceGallery() {
        guard galleryMode, galleryIndex + 1 < Self.galleryStates.count else { return }
        galleryIndex += 1
        presentGalleryState()
    }

    /// Render the current carousel state from a clean slate. State + coordinator
    /// are rebuilt per state (the equivalent of the old fresh-scene-per-state) so no
    /// overlay/roster state can leak between captures — including the room identity,
    /// or an earlier lobby state's QR would leak into the room-less create-error
    /// shots through applyShot's buildLobby fold-in.
    private func presentGalleryState() {
        let entry = Self.galleryStates[galleryIndex]
        state = UiModel()
        room = nil
        joinURL = nil
        qrText = nil
        boardScene.resetBoards()
        makeCoordinator(relayBacked: false)
        applyShot(entry.shot, playerCount: entry.players)
        // Report ready once labels / QR / board textures have rasterized AND the
        // longest entrance animation has settled (lobby ⓘ button: 0.6s delay +
        // 0.5s fade); the process is warm, so this still beats per-state cold
        // launches.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.3) { [weak self] in
            self?.galleryMarker = entry.name
        }
    }

    /// Render a single frozen gallery state. Base states delegate to the
    /// coordinator's fixture renderer; special cases layer overlay/focus state
    /// on top of a base shot.
    private func applyShot(_ shot: String, playerCount pc: Int) {
        switch shot {
        case "pause-music":   // pause overlay with the MUSIC switch focused
            coordinator?.renderShot("pause", playerCount: pc)
            state.focusMusicForShot = true
        case "reconnecting":  // full-screen display-disconnect overlay over a game
            coordinator?.renderShot("game", playerCount: pc)
            // Gallery parity with web (DisplayTestHarness shows "Attempt 2 of 5"):
            // the live retry tick that would set this never fires in a static shot.
            state.connection = .reconnecting
            state.reconnectAttempt = 2
            state.reconnectMax = 5
        case "disconnected-display":
            coordinator?.renderShot("game", playerCount: pc)
            state.connection = .closed
        case "create-error-retry":  // first-launch create failed, auto-retrying
            // Reconnect overlay over the empty, room-less waiting lobby (matching
            // web): a failed create now reads exactly like a lost room.
            state.screen = .lobby
            state.lobby = LobbyData()
            state.connection = .reconnecting
            state.reconnectAttempt = 1
            state.reconnectMax = 5
        case "create-error":        // create attempts exhausted → DISCONNECTED + RECONNECT
            state.screen = .lobby
            state.lobby = LobbyData()
            state.connection = .closed
        case "about":         // full-screen About overlay (Privacy / Imprint QR + Licenses drill-in)
            coordinator?.renderShot("lobby-empty", playerCount: pc)
            state.showAbout = true
        case "licenses":      // full-screen Licenses overlay (scrolled to top)
            coordinator?.renderShot("lobby-empty", playerCount: pc)
            state.showAbout = true
            state.showLicenses = true
        default:
            coordinator?.renderShot(shot, playerCount: pc)
        }
        // The fixtures seed RoomFlow directly (no roster broadcast), so fold the
        // seeded roster into the published lobby here or host-tinted chrome
        // (pause CONTINUE, music switch, results PLAY AGAIN) would render its
        // accent fallback in every shot.
        if state.lobby == nil || state.lobby?.players.isEmpty == true {
            state.lobby = buildLobby()
        }
    }
}

// MARK: - DisplayOutput

extension DisplayModel: DisplayOutput {

    func showScreen(_ screen: DisplayScreen) {
        guard screen != state.screen || pendingGameReveal else { return }
        boardScene.showScreen(screen)
        // The About / licenses overlays are lobby-only; a match starting (from a
        // controller while one is open) must not leave it stranded over the game.
        if screen != .lobby { state.showAbout = false; state.showLicenses = false }
        switch screen {
        case .lobby:
            // Instant swap (web parity): the lobby's own entrance stagger is the
            // transition. Also drop any lingering countdown, and seat the menu
            // cursor back on START (a stale ⓘ focus from the previous visit
            // reads as random after a match).
            pendingGameReveal = false
            var s = state
            s.screen = .lobby
            s.countdown = nil
            s.lobbyFocus = .start
            state = s
        case .results:
            pendingGameReveal = false
            withAnimation(Self.resultsFade) { state.screen = .results }
        case .game:
            pendingGameReveal = true
        }
    }

    func roomReady(room: String, joinURL: String, qrText: String) {
        // The relay confirmed the room (`created`, or `joined` after a rejoin), so
        // the QR is trustworthy again — the ONLY place the pending dim clears.
        // The QR pattern and join line derive from this state inside the
        // still-animating lobby view, so a mid-entrance confirm can't pop a
        // second card over the fading one (the old rebuild double-fade).
        self.room = room
        self.joinURL = joinURL
        self.qrText = qrText
        state.qrPending = false
        state.lobby = buildLobby()
    }

    func updateLobby(players: [PlayerRecord], hostPeerIndex: Int?) {
        // Unguarded (Android parity): results/pause CTAs read the live host
        // color from this state, so a mid-game host handoff retints them via
        // plain recomposition — no imperative retint plumbing.
        state.lobby = buildLobby(players: players, hostPeerIndex: hostPeerIndex)
    }

    private func buildLobby(players: [PlayerRecord]? = nil, hostPeerIndex: Int? = nil) -> LobbyData {
        let roster = players ?? coordinator?.flow.list() ?? []
        let host = hostPeerIndex ?? coordinator?.flow.host
        return LobbyData(
            room: room ?? "",
            joinURL: joinURL ?? "",
            qrText: qrText ?? "",
            players: roster.map {
                LobbySeat(peerIndex: $0.peerIndex, name: $0.playerName,
                          colorSlot: $0.colorSlot, level: $0.startLevel, joinedAt: $0.joinedAt)
            },
            hostColorSlot: host.flatMap { h in roster.first { $0.peerIndex == h }?.colorSlot }
        )
    }

    func showCountdown(_ value: CountdownValue) {
        withAnimation(Self.enterFade) {
            if pendingGameReveal {
                pendingGameReveal = false
                state.screen = .game
            }
            state.countdown = value
        }
        if case .go = value { armGoDismissal() }
    }

    /// GO holds 0.4s, then the scrim fades off (web overlayTimer + the 0.25s
    /// dismissal fade). Declines while paused — the web clears its countdown
    /// timers on pause for the same reason — and setPaused(false) re-arms the
    /// full hold, so a pause landing inside the GO window can't strand the
    /// resumed game behind (or without) the scrim.
    private func armGoDismissal() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
            guard let self, self.state.countdown == .go, !self.state.paused else { return }
            withAnimation(Self.countdownExitFade) { self.state.countdown = nil }
        }
    }

    func renderSnapshot(_ snapshot: GameSnapshot) {
        // Gallery fixtures render game states with no countdown, so the frozen
        // snapshot is what reveals the screen there. Live flows keep waiting
        // for the countdown: beginCountdown renders a pre-game snapshot in the
        // same call as showScreen(.game), long before the scrim is ready.
        if pendingGameReveal && shotMode {
            pendingGameReveal = false
            state.screen = .game
        }
        boardScene.renderSnapshot(snapshot)
    }

    func handleGameEvent(_ event: GameEvent) {
        boardScene.handleGameEvent(event)
    }

    func showResults(_ results: [MatchResult]) {
        state.results = results
    }

    func setDisconnected(playerId: Int, joinURL: String?) {
        boardScene.setDisconnected(playerId: playerId, joinURL: joinURL)
    }

    func setLobbyAmbient(_ pieces: [AmbientPiece]) {
        boardScene.setLobbyAmbient(pieces)
    }

    func setPaused(_ paused: Bool) {
        withAnimation(paused ? Self.enterFade : Self.exitFade) { state.paused = paused }
        if !paused, state.countdown == .go { armGoDismissal() }
    }

    func setDisplayMuted(_ muted: Bool) {
        state.muted = muted
    }

    func playCountdownBeep(go: Bool) { music.playBeep(go: go) }
    func startMusic() { music.start() }
    func stopMusic() { music.stop() }
    func pauseMusic() { music.pause() }
    func resumeMusic() { music.resume() }
}
