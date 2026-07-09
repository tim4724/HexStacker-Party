import Foundation

public enum DisplayScreen: Equatable { case lobby, game, results }
public enum CountdownValue: Equatable { case number(Int), go }

/// Side-effects the coordinator drives (rendering, audio, screen changes). The
/// tvOS app provides a concrete implementation (SpriteKit + AVFoundation +
/// SwiftUI); tests provide a fake to assert behavior headlessly.
public protocol DisplayOutput: AnyObject {
    func showScreen(_ screen: DisplayScreen)
    /// The room is open: show the lobby with `joinURL` as the displayed host/code
    /// and `qrText` as the QR payload. In production the two are identical (the QR
    /// encodes the join URL); the screen gallery's JOIN fixture makes them differ.
    func roomReady(room: String, joinURL: String, qrText: String)
    func updateLobby(players: [PlayerRecord], hostPeerIndex: Int?)
    func showCountdown(_ value: CountdownValue)
    func renderSnapshot(_ snapshot: GameSnapshot)
    func handleGameEvent(_ event: GameEvent)
    func showResults(_ results: [[String: Any]])
    /// Show (joinURL != nil) or clear (nil) a per-board disconnect/rejoin overlay.
    func setDisconnected(playerId: Int, joinURL: String?)
    /// Freeze the lobby's ambient falling-piece background to these fixture pieces
    /// (screen-gallery shots only); production keeps its live animation. Optional.
    func setLobbyAmbient(_ pieces: [AmbientPiece])
    /// Show/hide the paused overlay (driven by the remote or a controller).
    func setPaused(_ paused: Bool)
    /// The display mute changed (remote toggle or the host phone's Game Music
    /// switch) — keep any visible music switch in sync.
    func setDisplayMuted(_ muted: Bool)
    func playCountdownBeep(go: Bool)
    func startMusic()
    func stopMusic()
    func pauseMusic()
    func resumeMusic()
}

public extension DisplayOutput {
    // Visual-only hooks are optional.
    func handleGameEvent(_ event: GameEvent) {}
    func setDisconnected(playerId: Int, joinURL: String?) {}
    func setLobbyAmbient(_ pieces: [AmbientPiece]) {}
    func setPaused(_ paused: Bool) {}
    func setDisplayMuted(_ muted: Bool) {}
}

/// The native display brain: owns the relay transport, the RoomFlow roster, and
/// the engine; implements the display-side protocol handling and game lifecycle
/// (lobby -> countdown -> playing -> results). Ported from DisplayGame.js /
/// DisplayInput.js / DisplayConnection.js. Single-threaded: call from the main
/// thread; `tick(deltaMs:)` is driven once per frame by the renderer.
public final class DisplayCoordinator {

    public let flow = RoomFlow()
    private let transport: RelayTransport
    // Optional peer-to-peer input fast path (WebRTC DataChannels). Controller
    // input arrives over it when open and falls back to the relay otherwise; the
    // relay always carries SDP/ICE signaling and display -> controller messages.
    // nil in headless/tests and when the WebRTC framework isn't linked, leaving
    // the relay as the sole input path (the v1 behavior).
    private let fastlane: InputFastlane?
    // weak: RootScene owns the coordinator and is its output (a delegate-style
    // back-reference). A strong ref here would form a RootScene <-> coordinator
    // cycle pinning the engine, relay and music for the app's lifetime.
    private weak var output: DisplayOutput?
    private let engineDirectory: URL
    private let seedProvider: () -> UInt32

    private var engine: EngineBridge?
    // The reusable JS runtime behind `engine`. Evaluating the bundle in a fresh
    // JSContext is the expensive part of a match start (in-process JSC has no JIT),
    // while Bridge.create re-inits a game on an existing runtime for free — so the
    // runtime is built ONCE (prewarmed off-main when the first controller says
    // hello, or synchronously at the first START) and reused for every match.
    // `engine` stays the match-scoped handle the state machine gates on.
    private var runtime: EngineBridge?
    private var runtimePrewarmInFlight = false
    private var room: String?
    private var instance: String?

    // Pause is a union of independent reasons so they don't clobber each other
    // (a host Continue must not un-pause an all-disconnected freeze, etc.). The
    // engine/music follow the effective `paused` via reconcilePause.
    private var pausedManual = false        // host / remote pressed Pause
    private var pausedAuto = false          // every participant disconnected (silent)
    private var pausedConnection = false    // the display's OWN relay link is down
    private var paused: Bool { pausedManual || pausedAuto || pausedConnection }
    // The display's own relay link is up. While it's down, controller traffic
    // can't arrive, so the controller-liveness sweep must be skipped (every
    // lastSeen is stale through no fault of the controllers).
    private var relayConnected = true

    // Monotonic clock fed to PartyCore.frame(); only deltas matter, so it never
    // needs resetting across games (a fresh engine re-primes on its first frame).
    private var frameClockMs = 0.0
    private var playerOrder: [Int] = []
    // Per-participant KO state, so a WELCOME sent to a reconnecting (or
    // display-blip re-welcomed) controller reports alive:false for a player who
    // was already KO'd — without this the eliminated phone flips back to the live
    // playing UI (mirrors the web's lastAliveState). Only ever records false; a
    // player defaults alive until KO'd.
    private var aliveState: [Int: Bool] = [:]
    // The enriched results of the just-finished match, replayed in the WELCOME to
    // a controller that joins/reconnects on the RESULTS screen so its phone shows
    // the ranking instead of a blank results view (mirrors the web's lastResults).
    private var lastResults: [[String: Any]]?
    private var pendingSeed: UInt32 = 0
    private var demoSeedOverride: UInt32?   // deterministic seed for HEXDEMO
    private var muted = false
    private let nowProvider: () -> Double    // wall-clock ms for liveness (injectable for tests)

    // Local demo (no relay/controllers): drives a game with synthetic input so
    // the renderer can be exercised and screenshotted headlessly.
    private var demoActive = false
    private var demoTick = 0

    // Countdown driven by accumulated frame time (deterministic, testable).
    private var countdownElapsed = 0.0
    private var countdownStep = -1   // last emitted step: 0->3,1->2,2->1,3->GO,4->start
    private static let stepMs = 1000.0
    private static let goHoldMs = 500.0

    private static let maxFrameDeltaMs = 50.0   // matches the web frame clamp

    public init(transport: RelayTransport,
                engineDirectory: URL,
                output: DisplayOutput,
                fastlane: InputFastlane? = nil,
                seedProvider: @escaping () -> UInt32 = { UInt32.random(in: 0...UInt32.max) },
                nowProvider: @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 }) {
        self.transport = transport
        self.engineDirectory = engineDirectory
        self.output = output
        self.fastlane = fastlane
        self.seedProvider = seedProvider
        self.nowProvider = nowProvider
    }

    public var state: RoomState { flow.state }
    public var isMuted: Bool { muted }

    // MARK: - Lifecycle

    public func start() {
        transport.onCreated = { [weak self] room, instance, region in
            self?.onCreated(room: room, instance: instance)
        }
        transport.onJoined = { [weak self] room, peers in
            self?.onJoined(room: room, peers: peers)
        }
        transport.onPeerJoined = { [weak self] idx in self?.onPeerJoined(idx) }
        transport.onPeerLeft = { [weak self] idx in self?.onPeerLeft(idx) }
        transport.onMessage = { [weak self] from, data in self?.onMessage(from: from, data: data) }
        transport.onRelayError = { [weak self] message in self?.onRelayError(message) }
        // Controller input arriving over the fastlane routes through the SAME
        // handler as relay input, so dedup/liveness/game logic is single-sourced.
        fastlane?.onInput = { [weak self] from, data in self?.onMessage(from: from, data: data) }
        flow.onRosterChange = { [weak self] players in
            self?.output?.updateLobby(players: players, hostPeerIndex: self?.flow.host)
        }
        // A silent disconnect mid-game can reshuffle the effective host; the new
        // host's controller must learn it gained the menu controls. LOBBY/RESULTS
        // already rebroadcast on roster changes, so only cover the in-game states.
        flow.onHostChange = { [weak self] _ in
            guard let self else { return }
            if self.flow.state == .countdown || self.flow.state == .playing {
                self.maybeBroadcastHostChange()
            }
        }
        transport.connect()
    }

    private func onCreated(room: String, instance: String?) {
        self.room = room
        self.instance = instance
        let url = joinURL(room: room, instance: instance)
        output?.roomReady(room: room, joinURL: url, qrText: url)   // production QR == join URL
        output?.showScreen(.lobby)
    }

    private func onJoined(room: String, peers: [Int]) {
        // Display relay-reconnect: reconcile present controllers and re-welcome
        // everyone. Re-stamp + un-flag the still-present peers (mirrors the web's
        // onDisplayRejoined) so they don't instantly expire on the next liveness
        // sweep, and clear any rejoin overlay that was raised during the blip.
        self.room = room
        let now = nowProvider()
        // We re-push WELCOME to everyone below, so a later host change must
        // broadcast regardless of the pre-disconnect sentinel (web parity).
        lastBroadcastedHostId = nil
        // Re-stamp the still-present peers and clear any rejoin overlay; collect the
        // ones the relay no longer lists, then route each through the SAME
        // state-aware onPeerLeft the web delegates to (lobby → remove the slot;
        // countdown/playing → keep the slot AND raise the per-board rejoin QR;
        // results → trim the order + maybe return to the lobby). Marking them
        // disconnected inline instead would strand the board with no rejoin QR and,
        // because expiredPeers skips already-disconnected peers, never self-heal.
        // Re-confirm the lobby QR: the link was down (QR untrusted, rendered dimmed)
        // and this `joined` proves the room survived, so the same code + QR are valid
        // again. The room-gone path re-confirms via onCreated instead.
        let url = joinURL(room: room, instance: instance)
        output?.roomReady(room: room, joinURL: url, qrText: url)
        var goneIds: [Int] = []
        for p in flow.list() {
            if peers.contains(p.peerIndex) {
                flow.onSeen(p.peerIndex, now)
                if flow.isDisconnected(p.peerIndex) {
                    flow.markReconnected(p.peerIndex)
                    output?.setDisconnected(playerId: p.peerIndex, joinURL: nil)
                }
            } else {
                goneIds.append(p.peerIndex)
            }
        }
        for id in goneIds { onPeerLeft(id) }
        for p in flow.list() { sendWelcome(to: p.peerIndex, isLateJoiner: isLateJoiner(p.peerIndex)) }
    }

    /// A relay-level `error`. A fatal room error on (re)connect — the relay lost
    /// the room, or it filled — is recovered by tearing down and opening a fresh
    /// room, exactly as the web display's resetToWelcome does (the TV has no
    /// welcome screen, so it lands straight back on the lobby). Other errors are
    /// non-fatal and ignored (the app UI surfaces them if needed).
    private func onRelayError(_ message: String) {
        guard message == "Room not found" || message == "Room is full" else { return }
        engine = nil
        output?.stopMusic()
        output?.setPaused(false)
        pausedManual = false; pausedAuto = false; pausedConnection = false
        aliveState = [:]
        lastResults = nil
        playerOrder = []
        lastBroadcastedHostId = nil
        flow.reset()                 // clear the roster + return to the lobby state
        output?.showScreen(.lobby)   // drop the frozen game immediately
        transport.recreateRoom()     // fresh room; onCreated re-shows the lobby with the new code
    }

    private func onPeerJoined(_ index: Int) {
        // An in-session reconnect lands on the SAME slot, so the relay re-emits
        // peer_joined for a peer we already know. Defer to the controller's HELLO
        // (onMessage clears its disconnect + restores the QR) rather than calling
        // addPlayer again, which would overwrite the kept color/level and strand
        // the rejoin overlay (mirrors the web's `if (players.has(i)) return`).
        guard !flow.contains(index) else { return }
        let slot = flow.lowestFreeSlot()
        guard slot >= 0 else {
            transport.sendTo(index, OutboundMessage.error(message: "Room is full"))
            return
        }
        flow.addPlayer(peerIndex: index, playerName: autoName(slot: slot), colorSlot: slot)
        if flow.state == .lobby { broadcastLobby() }
    }

    private func onPeerLeft(_ index: Int) {
        // Drop any peer-to-peer channel to the departed controller; a reconnecting
        // controller re-offers and a fresh fastlane peer is built (web parity).
        fastlane?.closePeer(index)
        switch flow.state {
        case .lobby:
            flow.removePlayer(index)
            if flow.size > 0 { broadcastLobby() }
        case .results:
            // Drop the leaver and return to the lobby once no connected participant
            // remains (late joiners don't count), mirroring the web RESULTS path.
            flow.removePlayer(index)
            playerOrder.removeAll { $0 == index }
            flow.setActiveOrder(playerOrder)
            if hasConnectedParticipant() {
                if flow.size > 0 { broadcastLobby() }
            } else {
                returnToLobby()
            }
        case .countdown, .playing:
            // End any in-progress soft drop so the departed board doesn't keep
            // falling fast until the engine's own deadline fires (web cleanupPlayerInput).
            engine?.softDropEnd(playerId: index)
            if playerOrder.contains(index) {
                flow.markDisconnected(index)   // keep slot
                output?.setDisconnected(playerId: index, joinURL: rejoinURL(index))
            } else {
                flow.removePlayer(index)
            }
        }
    }

    /// A peer that is part of the current round (the active order). Used to gate
    /// the welcome's alive/paused payload and the RESULTS return-to-lobby.
    private func isLateJoiner(_ id: Int) -> Bool {
        (flow.state == .playing || flow.state == .countdown) && !playerOrder.contains(id)
    }

    /// Any active participant still present and connected.
    private func hasConnectedParticipant() -> Bool {
        playerOrder.contains { flow.contains($0) && !flow.isDisconnected($0) }
    }

    // MARK: - Inbound messages

    private func onMessage(from: Int, data: [String: Any]) {
        // Intercept WebRTC signaling envelopes for the fastlane before app
        // dispatch — handleSignal returns true iff it was an `__rtc` message.
        // (Fastlane-delivered input loops back here too, but as a plain controller
        // message, so it falls straight through to the parse below.)
        if let fastlane, fastlane.handleSignal(from: from, data: data) { return }
        guard let msg = ControllerMessage(data) else { return }
        flow.onSeen(from, nowProvider())
        if flow.isDisconnected(from) {
            flow.markReconnected(from)
            output?.setDisconnected(playerId: from, joinURL: nil)   // clear rejoin overlay
            if pausedAuto { autoResume() }                          // a participant returned
        }

        switch msg.type {
        case MSG.hello: handleHello(from: from, msg: msg)
        case MSG.input: handleInput(from: from, msg: msg)
        case MSG.softDrop:
            // Guard the Double->Int conversion: a malformed `speed` (e.g. 1e308)
            // would trap in Int.init and abort the display; ignore it instead.
            if flow.state == .playing, !paused {
                engine?.softDropStart(playerId: from, speed: msg.speed.flatMap { $0.isFinite && abs($0) < 9.0e15 ? Int($0) : nil })
            }
        case MSG.softDropEnd:
            if flow.state == .playing { engine?.softDropEnd(playerId: from) }
        case MSG.startGame:
            if flow.state == .lobby, flow.size >= 1 { beginCountdown() }
        case MSG.playAgain:
            if flow.state == .results, flow.size >= 1 { beginCountdown() }
        case MSG.returnToLobby: returnToLobby()
        case MSG.pauseGame: pauseGame()
        case MSG.resumeGame: resumeGame()
        case MSG.leave: onPeerLeft(from)
        case MSG.setLevel: handleSetLevel(from: from, msg: msg)
        case MSG.setColor: handleSetColor(from: from, msg: msg)
        case MSG.setName: handleSetName(from: from, msg: msg)
        case MSG.setDisplayMute: handleSetMute(from: from, msg: msg)
        case MSG.ping: transport.sendTo(from, OutboundMessage.pong(t: msg.t))
        default: break
        }
    }

    private func handleHello(from: Int, msg: ControllerMessage) {
        // Cross-device mid-game rejoin: a returning participant arrives under a NEW
        // peer index carrying ?claim=<oldIdx> (sent as rejoinToken/rejoinId). Re-key
        // the kept record + engine state onto the new index instead of seating them
        // as a fresh late joiner. Mirrors the web's claimReconnectPeer.
        if claimReconnect(from: from, msg: msg) { return }

        if flow.player(from) == nil {
            let slot = flow.lowestFreeSlot()
            guard slot >= 0 else {
                transport.sendTo(from, OutboundMessage.error(message: "Room is full"))
                return
            }
            let name = sanitizeName(msg.name) ?? autoName(slot: slot)
            flow.addPlayer(peerIndex: from, playerName: name, colorSlot: slot)
            flow.onSeen(from, nowProvider())
        } else if let name = sanitizeName(msg.name), msg.autoName != true {
            flow.player(from)?.playerName = name
        }
        sendWelcome(to: from, isLateJoiner: isLateJoiner(from))
        if flow.state == .lobby || flow.state == .results { broadcastLobby() }
        // Someone is in the lobby, so a START may follow: get the runtime ready.
        if flow.state == .lobby { prewarmRuntime() }
    }

    /// Honor a `?claim=<oldIdx>` rejoin: move the dropped participant's slot, board
    /// and garbage state from `oldId` to the returning peer `from`. Returns true if
    /// the claim was applied (caller is done). Only valid for a disconnected
    /// participant of the current round.
    private func claimReconnect(from: Int, msg: ControllerMessage) -> Bool {
        // `!playerOrder.contains(from)`: an active participant can't claim
        // another board — rekeying onto an id that already owns a board would
        // silently drop one of the two in the engine's Map rebuild (a forged
        // rejoinToken in a re-sent HELLO could otherwise corrupt the match).
        // A genuine cross-device rejoin always arrives under a FRESH index.
        guard let oldId = msg.rejoinToken ?? msg.rejoinId, oldId != from,
              flow.isDisconnected(oldId), playerOrder.contains(oldId),
              !playerOrder.contains(from) else { return false }
        // Engine-first: re-key the engine board (input + snapshot map to the kept
        // board) BEFORE moving the roster, so a failed engine rekey can't leave the
        // roster pointing at a board the engine never moved. engine is non-nil here
        // (built in beginCountdown); guard defensively, and with no engine there is
        // no board to desync from a roster-only move.
        if let engine, !engine.rekeyPlayer(oldId: oldId, newId: from) { return false }
        guard flow.rekey(oldId: oldId, newId: from) else { return false }
        playerOrder = playerOrder.map { $0 == oldId ? from : $0 }
        flow.setActiveOrder(playerOrder)
        flow.onSeen(from, nowProvider())
        // Carry the KO state onto the new peer index so a claim-rejoin after a KO
        // still reports alive:false in its welcome (web parity).
        if let wasAlive = aliveState.removeValue(forKey: oldId) { aliveState[from] = wasAlive }
        // Remap the cached ranking too: a claim on the RESULTS screen (player
        // dropped mid-game, match ended before they returned) replays
        // lastResults in the WELCOME, and the controller matches its own row
        // by playerId (web parity: claimReconnectPeer does the same).
        lastResults = lastResults?.map { entry in
            var e = entry
            if e["playerId"] as? Int == oldId { e["playerId"] = from }
            return e
        }
        output?.setDisconnected(playerId: oldId, joinURL: nil)   // clear the dropped board's rejoin QR
        if pausedAuto { autoResume() }                          // a participant returned
        sendWelcome(to: from, isLateJoiner: false)
        if flow.state == .lobby || flow.state == .results { broadcastLobby() }
        return true
    }

    private func handleInput(from: Int, msg: ControllerMessage) {
        guard flow.state == .playing, !paused, let action = msg.action,
              InputAction(rawValue: action) != nil else { return }
        engine?.processInput(playerId: from, action: action)
        // Render-on-input: reflect the applied input on the very next display frame
        // instead of waiting for the next tick(). snapshot() is a pure read (value-copy,
        // no time advance), so it only front-runs the VISUAL; this frame's events/commands
        // (lock flash, garbage, sends) still flow on the next tick(). Mirrors the Android path.
        if let engine, let snap = try? engine.snapshot() { output?.renderSnapshot(snap) }
    }

    private func handleSetLevel(from: Int, msg: ControllerMessage) {
        guard let level = msg.level, (1...15).contains(level), let rec = flow.player(from) else { return }
        rec.startLevel = level
        if flow.state == .lobby { sendLobbyUpdate(to: from); refreshDisplayLobby() }
    }

    private func handleSetColor(from: Int, msg: ControllerMessage) {
        guard let slot = msg.colorIndex, (0..<EngineConstants.maxPlayers).contains(slot),
              let rec = flow.player(from) else { return }
        // Reject if taken by another player.
        if flow.list().contains(where: { $0.peerIndex != from && $0.colorSlot == slot }) { return }
        rec.colorSlot = slot
        broadcastLobby()
    }

    private func handleSetName(from: Int, msg: ControllerMessage) {
        guard let name = sanitizeName(msg.name), let rec = flow.player(from) else { return }
        rec.playerName = name
        if from == flow.host { broadcastLobby() }
        else if flow.state == .lobby || flow.state == .results { refreshDisplayLobby() }
    }

    private func handleSetMute(from: Int, msg: ControllerMessage) {
        guard from == flow.host else { return }
        muted = (msg.muted == true)
        transport.broadcast(OutboundMessage.displayMuted(muted))
        // Apply to live audio immediately (mirrors remoteToggleMute); without this
        // the flag only took effect at the next match start.
        if muted { output?.pauseMusic() }
        else if flow.state == .playing && !paused { output?.resumeMusic() }
        output?.setDisplayMuted(muted)   // keep a visible pause-menu switch live
    }

    // MARK: - Countdown + game

    private func beginCountdown() {
        guard flow.transition(to: .countdown) else { return }
        pruneDisconnected()
        // Late joiners enter the participant order, sorted by join time so the
        // leftmost board is the first joiner.
        for id in flow.list().map({ $0.peerIndex }) where !playerOrder.contains(id) { playerOrder.append(id) }
        playerOrder = playerOrder.filter { flow.contains($0) }
        playerOrder.sort { (flow.player($0)?.joinedAt ?? .max) < (flow.player($1)?.joinedAt ?? .max) }
        // Pruning may have emptied the round (e.g. a Play-Again that races the
        // presence sweep with every participant already gone). Don't launch a
        // zero-player engine — bounce back to the lobby (web parity).
        guard !playerOrder.isEmpty else { returnToLobby(); return }
        flow.setActiveOrder(playerOrder)
        // Stamp everyone present so a controller that went briefly quiet in the
        // lobby isn't instantly expired once the COUNTDOWN liveness gate applies.
        flow.primeLiveness(nowProvider())
        pendingSeed = demoSeedOverride ?? seedProvider()
        pausedManual = false; pausedAuto = false; pausedConnection = false
        aliveState = [:]      // fresh match: everyone alive, last ranking is stale
        lastResults = nil
        countdownElapsed = 0
        countdownStep = -1

        // Build the engine now and show the game screen so the boards are visible
        // behind the countdown overlay, matching the web's 3-2-1-GO over the game
        // board. Render the PRE-GAME projection (empty wells: no spawn piece,
        // ghost, hold, or next queue) — the web hides those until play begins.
        guard makeEngine() else { returnToLobby(); return }
        output?.showScreen(.game)
        if let engine, let snap = try? engine.snapshot() { output?.renderSnapshot(snap.preGame()) }
    }

    private func makeEngine() -> Bool {
        let players: [(id: Int, startLevel: Int)] = playerOrder.map {
            (id: $0, startLevel: flow.player($0)?.startLevel ?? 1)
        }
        do {
            let e = try runtime ?? EngineBridge(engineDirectory: engineDirectory)
            // Surface fire-and-forget engine exceptions instead of dropping them.
            e.onEngineError = { message in
                FileHandle.standardError.write(Data("[engine] \(message)\n".utf8))
            }
            try e.createGame(players: players, seed: pendingSeed)
            runtime = e
            engine = e
            return true
        } catch {
            runtime = nil // don't reuse a runtime that failed mid-create
            FileHandle.standardError.write(Data("[engine] createGame failed: \(error)\n".utf8))
            return false
        }
    }

    /// Build the JS runtime ahead of the first match, off the main thread, so the
    /// START press doesn't pay the bundle evaluation. Triggered when a controller
    /// joins the lobby — always seconds before any START. JSC serializes context
    /// access via the virtual machine's lock, so constructing on a background
    /// queue and using on main afterwards is safe. If a START wins the race,
    /// makeEngine builds its own runtime and the late prewarm result is discarded.
    private func prewarmRuntime() {
        guard runtime == nil, !runtimePrewarmInFlight else { return }
        runtimePrewarmInFlight = true
        let dir = engineDirectory
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let e = try? EngineBridge(engineDirectory: dir)
            DispatchQueue.main.async {
                guard let self else { return }
                self.runtimePrewarmInFlight = false
                if self.runtime == nil { self.runtime = e }
            }
        }
    }

    private func startPlaying() {
        // The engine and game screen are already set up in beginCountdown; go
        // live so tick() starts advancing the simulation.
        flow.transition(to: .playing)
        transport.broadcast(OutboundMessage.gameStart())
    }

    /// Drive one frame. The renderer calls this every display tick with the real
    /// elapsed milliseconds.
    public func tick(deltaMs rawDelta: Double) {
        let deltaMs = min(max(rawDelta, 0), Self.maxFrameDeltaMs)
        // The local demo has no controllers sending heartbeats, so keep its
        // synthetic players "seen" — otherwise the liveness sweep flags them
        // disconnected after 3 s and auto-pauses the self-playing game.
        if demoActive, flow.state == .countdown || flow.state == .playing {
            flow.primeLiveness(nowProvider())
        }
        switch flow.state {
        case .countdown:
            pollPresence(nowProvider())
            guard flow.state == .countdown else { return }
            advanceCountdown(deltaMs: deltaMs)
        case .playing:
            pollPresence(nowProvider())
            // pollPresence can return to lobby (grace) — re-check before ticking.
            guard flow.state == .playing, !paused, let engine else { return }
            if demoActive { driveDemoInput() }
            // Pull one engine frame through PartyCore (the native integration
            // surface): it ticks, drains events, value-copies the snapshot and
            // normalizes host effects in a single call. `frameClockMs` is the
            // monotonic clock PartyCore turns into a capped per-frame delta.
            frameClockMs += deltaMs
            guard let frame = try? engine.frame(nowMs: frameClockMs) else { return }
            // Events are the complete record — drive the native-only board
            // animations from them (line clears, lock flashes, KO, shakes).
            for event in frame.events { output?.handleGameEvent(event) }
            output?.renderSnapshot(frame.snapshot)
            // Commands normalize the host effects (controller sends, match end),
            // single-sourced from PartyCore so they can't drift from the web.
            dispatchCommands(frame.commands)
        case .results:
            // Run presence so the results screen returns to the lobby once every
            // controller has dropped (web RESULTS auto-return).
            pollPresence(nowProvider())
        case .lobby:
            break
        }
    }

    private func advanceCountdown(deltaMs: Double) {
        if countdownStep < 0 {
            // step 0 fires immediately at entry
            emitCountdownStep(0)
            return
        }
        guard !paused else { return }
        countdownElapsed += deltaMs
        let nextStep = countdownStep + 1
        let threshold = (nextStep <= 3) ? Double(nextStep) * Self.stepMs
                                        : 3 * Self.stepMs + Self.goHoldMs
        if countdownElapsed >= threshold { emitCountdownStep(nextStep) }
    }

    private func emitCountdownStep(_ step: Int) {
        countdownStep = step
        switch step {
        // Beeps are gated by `!muted` (like startMusic below), matching the web
        // where playCountdownBeep returns early when muted (DisplayAudio.js).
        case 0: transport.broadcast(OutboundMessage.countdown(value: 3)); output?.showCountdown(.number(3)); if !muted { output?.playCountdownBeep(go: false) }
        case 1: transport.broadcast(OutboundMessage.countdown(value: 2)); output?.showCountdown(.number(2)); if !muted { output?.playCountdownBeep(go: false) }
        case 2: transport.broadcast(OutboundMessage.countdown(value: 1)); output?.showCountdown(.number(1)); if !muted { output?.playCountdownBeep(go: false) }
        case 3:
            transport.broadcast(OutboundMessage.countdown(value: "GO"))
            output?.showCountdown(.go)
            if !muted { output?.playCountdownBeep(go: true); output?.startMusic() }
        default:
            startPlaying()
        }
    }

    /// Map PartyCore's normalized host-effect commands to controller sends and
    /// the match-end transition. Board animations are driven separately from the
    /// frame's `events`. Mirrors the
    /// web DisplayGame onEvent/onGameEnd handlers, now single-sourced through the
    /// command vocabulary (see server/PartyCore.d.ts).
    private func dispatchCommands(_ commands: [HostCommand]) {
        for c in commands {
            switch c.type {
            case "playerState":
                guard let pid = c.playerId else { break }
                if c.alive == false { aliveState[pid] = false }   // remember the KO for reconnect resync
                if let level = c.level, let lines = c.lines, let alive = c.alive {
                    // Full form (after a line clear): level/lines/alive + pre-resolved
                    // incoming garbage.
                    transport.sendTo(pid, OutboundMessage.playerState(
                        level: level, lines: lines, alive: alive,
                        garbageIncoming: c.garbageIncoming ?? 0))
                } else if c.alive == false {
                    // Short form (after a KO): just alive:false.
                    transport.sendTo(pid, OutboundMessage.playerDead())
                }
            case "playerEliminated":
                if let pid = c.playerId {
                    aliveState[pid] = false
                    transport.sendTo(pid, OutboundMessage.gameOver())
                }
            case "gameEnd":
                endGame(results: c.results ?? [], elapsed: c.elapsed ?? 0)
            default:
                // pieceLock / lineClear / playerKO / garbageCancelled / garbageSent
                // are rendered from `events`.
                break
            }
        }
    }

    private func endGame(results: [PlayerResult], elapsed: Double) {
        let enriched = enrichResults(results)
        lastResults = enriched   // replayed in the WELCOME to controllers joining on RESULTS
        flow.transition(to: .results)
        output?.stopMusic()
        // Clear any pause overlay/menu BEFORE building the results menu — setPaused
        // clears the focus menu, so it must run before showResults sets the
        // results buttons (otherwise the results menu is wiped → no Left/Right).
        output?.setPaused(false)
        transport.broadcast(OutboundMessage.gameEnd(elapsed: elapsed, results: enriched))
        output?.showResults(enriched)
        output?.showScreen(.results)   // reveal the results layer (hide the frozen game)
        engine = nil
    }

    private func returnToLobby() {
        guard flow.state != .lobby else { return }
        pausedManual = false; pausedAuto = false; pausedConnection = false
        aliveState = [:]
        lastResults = nil
        engine = nil
        output?.stopMusic()
        output?.setPaused(false)
        pruneDisconnected()
        playerOrder = []
        flow.clearDisconnected()
        flow.transition(to: .lobby)
        broadcastLobby()
        transport.broadcast(OutboundMessage.returnToLobby(playerCount: flow.size))
        output?.showScreen(.lobby)
    }

    /// Drive the engine + music to match the effective `paused` after a reason flag
    /// changed. Idempotent; re-primes the frame clock on freeze so the first frame
    /// after resume re-primes with delta 0 instead of a catch-up jump.
    private func reconcilePause(wasPaused: Bool) {
        guard paused != wasPaused else { return }
        if paused {
            engine?.pause()
            engine?.resetFrameClock()
            output?.pauseMusic()
        } else {
            engine?.resume()
            if !muted { output?.resumeMusic() }
        }
    }

    private var isPausableState: Bool { flow.state == .playing || flow.state == .countdown }

    private func pauseGame() {   // host / remote (Pause)
        guard isPausableState, !pausedManual else { return }
        let was = paused; pausedManual = true; reconcilePause(wasPaused: was)
        output?.setPaused(true)
        transport.broadcast(OutboundMessage.gamePaused())
    }

    private func resumeGame() {  // host / remote (Continue)
        guard isPausableState, pausedManual, !flow.allParticipantsDisconnected else { return }
        let was = paused; pausedManual = false; reconcilePause(wasPaused: was)
        output?.setPaused(false)
        transport.broadcast(OutboundMessage.gameResumed())
    }

    /// Silent auto-pause when every participant has disconnected: no overlay, no
    /// broadcast (all controllers are gone). Absorbs an in-progress manual pause
    /// (converting it and hiding its overlay) so the overlay isn't stranded.
    private func autoPauseAllDisconnected() {
        guard flow.state == .playing, !pausedAuto else { return }
        let was = paused
        // If the host had already manually paused, convert that into the auto-pause
        // and hide the stranded overlay: resumeGame is gated shut while everyone is
        // gone, so a manual pause left showing could never be dismissed via Continue.
        // A reconnect auto-resumes. Web DisplayGame.js dismissAutoPausedOverlay.
        if pausedManual { pausedManual = false; output?.setPaused(false) }
        pausedAuto = true
        reconcilePause(wasPaused: was)
    }

    /// A participant returned — lift the all-disconnected auto-pause.
    private func autoResume() {
        guard pausedAuto, !flow.allParticipantsDisconnected else { return }
        let was = paused; pausedAuto = false; reconcilePause(wasPaused: was)
        if !paused { transport.broadcast(OutboundMessage.gameResumed()) }
    }

    /// The display's OWN relay link dropped: freeze the sim so it doesn't run blind
    /// behind the reconnect overlay. No broadcast (the relay is down). Driven by
    /// the connection-state observer (setRelayConnected).
    private func connectionPause() {
        guard flow.state == .playing || flow.state == .countdown, !pausedConnection else { return }
        let was = paused; pausedConnection = true; reconcilePause(wasPaused: was)
    }

    private func connectionResume() {
        guard pausedConnection else { return }
        let was = paused; pausedConnection = false; reconcilePause(wasPaused: was)
    }

    /// Observe the display's relay link: freeze on drop, resume on reconnect, so a
    /// recoverable outage doesn't KO players who can't send input meanwhile.
    public func setRelayConnected(_ connected: Bool) {
        relayConnected = connected
        if connected {
            // Re-stamp present controllers so a >timeout outage doesn't instantly
            // expire them on the first post-reconnect sweep.
            flow.primeLiveness(nowProvider())
            connectionResume()
        } else {
            connectionPause()
        }
    }

    // MARK: - Presence / liveness

    /// Once-per-frame presence sweep (countdown + playing). Flags silently-dead
    /// controllers, returns to the lobby after the late-joiner grace, and silently
    /// auto-pauses / auto-resumes on the all-disconnected boundary. Mirrors the web
    /// DisplayLiveness loop + checkAllPlayersDisconnected.
    private func pollPresence(_ now: Double) {
        // Skip the controller-liveness sweep while the display's OWN link is down:
        // no controller traffic can arrive, so every lastSeen is stale through no
        // fault of the controllers (web DisplayLiveness `displayDead` early-return).
        // Without this, a recoverable display outage would expire every controller
        // and (with a late joiner) grace-return the match to the lobby.
        guard relayConnected else { return }
        for id in flow.expiredPeers(now) {
            flow.markDisconnected(id)
            // The per-board rejoin QR only applies while boards are on screen.
            if flow.state == .countdown || flow.state == .playing {
                output?.setDisconnected(playerId: id, joinURL: rejoinURL(id))
            }
        }
        switch flow.state {
        case .playing:
            if flow.graceTick(now) { returnToLobby(); return }
            if flow.allParticipantsDisconnected {
                autoPauseAllDisconnected()
            } else if pausedAuto {
                autoResume()
            }
        case .results:
            // No connected controller left on the results screen → back to the
            // lobby (mirrors the web RESULTS peer-left path; controllers ping at
            // 1 Hz, so an idle-but-connected controller is never expired here).
            if !hasConnectedParticipant() { returnToLobby() }
        case .lobby, .countdown:
            break
        }
    }

    /// Re-publish the room state iff the effective host changed since the last
    /// broadcast (mirror of web maybeBroadcastHostChange). Skips when nobody is
    /// left to notify.
    private var lastBroadcastedHostId: Int?
    private func maybeBroadcastHostChange() {
        guard flow.size > 0, flow.host != lastBroadcastedHostId else { return }
        broadcastLobby()
    }

    // MARK: - Apple TV remote (display-side controls)

    /// Start a match from the lobby (or play again from results).
    public func remoteStartMatch() {
        if (flow.state == .lobby || flow.state == .results) && flow.size >= 1 { beginCountdown() }
    }

    /// Return to the lobby (the "New Game" action on results / pause).
    public func remoteReturnToLobby() {
        if flow.state != .lobby { returnToLobby() }
    }

    /// Pause/resume during a game or the 3-2-1 countdown (the web allows both).
    public func remoteTogglePause() {
        guard isPausableState else { return }
        if pausedManual { resumeGame() } else { pauseGame() }
    }

    /// The Play/Pause button: context toggle — start in the lobby, play again on
    /// results, pause/resume (Continue) during a game or countdown.
    public func remotePlayPause() {
        switch flow.state {
        case .lobby, .results: remoteStartMatch()
        case .countdown, .playing: remoteTogglePause()
        }
    }

    /// The tvOS app is backgrounding. Deliberately NOT the web's pagehide
    /// close_room teardown: a page that hides is gone for good, but a
    /// backgrounded app can come straight back (Home and back), so the party
    /// survives. Controllers learn of the absence via the relay's peer_left
    /// (RelayClient.suspend), keep their seats, and bail on their own if the
    /// display stays gone. Tear down P2P channels; on foregrounding the
    /// controllers re-offer.
    public func displayDidEnterBackground() {
        fastlane?.closeAll()
    }

    /// Toggle the display's own music mute. Returns the new muted state so the
    /// UI can show a brief indicator.
    @discardableResult
    public func remoteToggleMute() -> Bool {
        muted.toggle()
        transport.broadcast(OutboundMessage.displayMuted(muted))
        if muted { output?.pauseMusic() }
        else if flow.state == .playing && !paused { output?.resumeMusic() }
        output?.setDisplayMuted(muted)
        return muted
    }

    // MARK: - Local demo

    /// Start a self-driving game with `playerCount` synthetic players and no
    /// relay/controllers. For rendering verification (screenshots) and visual
    /// parity checks. `seed` is fixed so the state matches the web harness.
    public func startLocalDemo(playerCount: Int = 2, seed: UInt32 = 0xBADCAFE) {
        demoActive = true
        demoTick = 0
        for i in 1...max(1, playerCount) {
            let slot = flow.lowestFreeSlot()
            flow.addPlayer(peerIndex: i, playerName: "Demo \(i)", colorSlot: max(0, slot))
        }
        demoSeedOverride = seed   // deterministic seed, applied inside beginCountdown
        beginCountdown()
    }

    /// Populate the lobby from the canonical roster + JOIN fixtures (no relay) so
    /// the lobby UI — filled player cards, colors, levels, host tint, join card —
    /// can be exercised/screenshotted. Shared by the HEXLOBBY dev mode and the
    /// gallery `lobby` shot.
    public func startLobbyDemo(playerCount: Int = 3) {
        showGalleryLobby(players: max(1, min(playerCount, EngineConstants.maxPlayers)))
    }

    // MARK: - Screenshot capture (gallery)

    /// Render one display state, frozen, from the canonical cross-platform
    /// GalleryFixtures data (the SAME roster / board snapshots / results the web
    /// and Android TV galleries render, so a difference between gallery columns is
    /// always a renderer difference). No relay, no live tick: the caller stops
    /// ticking the coordinator so the state holds still for a capture. HEXPLAYERS
    /// drives the roster-based states; the named board variants (game-2p/3p/4p/8p)
    /// fix their own player count.
    public func renderShot(_ state: String, playerCount: Int = 4) {
        switch state {
        case "lobby":
            showGalleryLobby(players: max(1, min(playerCount, EngineConstants.maxPlayers)))
        case "lobby-empty":
            showGalleryLobby(players: 0)
        case "countdown":
            showGalleryCountdown(players: max(1, min(playerCount, EngineConstants.maxPlayers)))
        case "game", "game-lv1":
            showGalleryGame(variant: "lv1")
        case "game-lv8":
            showGalleryGame(variant: "lv8")
        case "game-lv12":
            showGalleryGame(variant: "lv12")
        case "game-2p":
            showGalleryGame(variant: "2p")
        case "game-3p":
            showGalleryGame(variant: "3p")
        case "game-4p":
            showGalleryGame(variant: "4p")
        case "game-8p":
            showGalleryGame(variant: "8p")
        case "pause":
            showGalleryGame(variant: "lv1")
            output?.setPaused(true)
        case "disconnected", "disconnected-controller":
            showGalleryGame(variant: "lv1")
            // Per-board rejoin QR for slot 1 (== id 1), encoding JOIN.qrText plus
            // the production ?claim=<peerIndex> param (mirrors showDisconnectQR).
            if let join = try? galleryFixtures()?.galleryJoin() {
                output?.setDisconnected(playerId: 1, joinURL: galleryRejoinURL(join.qrText, claim: 1))
            }
        case "results":
            showGalleryResults(count: max(1, min(playerCount, EngineConstants.maxPlayers)))
        case "results-solo":
            showGalleryResults(count: 1)
        default:
            showGalleryLobby(players: max(1, min(playerCount, EngineConstants.maxPlayers)))
        }
    }

    // MARK: - Gallery fixture rendering

    /// A JavaScriptCore bridge used only to read the static GalleryFixtures data
    /// (built lazily, reused across a shot). nil if the core bundle fails to load.
    private var galleryBridge: EngineBridge?
    private func galleryFixtures() -> EngineBridge? {
        if galleryBridge == nil { galleryBridge = try? EngineBridge(engineDirectory: engineDirectory) }
        return galleryBridge
    }

    /// Seed the RoomFlow roster from `roster(count)` (id == slot == colorIndex) so
    /// board / card lookups resolve the canonical names, colors and levels. Returns
    /// the fixture entries (the levels feed the pre-game countdown boards).
    @discardableResult
    private func seedGalleryRoster(count: Int) -> [GalleryRosterEntry] {
        guard let roster = try? galleryFixtures()?.galleryRoster(count: count) else { return [] }
        for e in roster {
            flow.addPlayer(peerIndex: e.id, playerName: e.name, colorSlot: e.slot, startLevel: e.level)
        }
        return roster
    }

    /// Show the lobby with the JOIN fixture: displayed host/code from JOIN.host +
    /// JOIN.code, QR from the (separate) JOIN.qrText, `players` roster cards.
    private func showGalleryLobby(players: Int) {
        guard let join = try? galleryFixtures()?.galleryJoin() else { return }
        if players > 0 { seedGalleryRoster(count: players) }
        // Reconstruct a URL splitJoinURL parses back to (JOIN.host, JOIN.code) for
        // the displayed text; the QR encodes the distinct JOIN.qrText.
        output?.roomReady(room: join.code, joinURL: "https://\(join.host)\(join.code)", qrText: join.qrText)
        // Freeze the ambient background to the shared fixture (after roomReady's
        // buildLobby seeds the live pool) so the lobby columns match across platforms.
        if let ambient = try? galleryFixtures()?.galleryAmbient() {
            output?.setLobbyAmbient(ambient)
        }
        output?.showScreen(.lobby)
    }

    /// The pre-game 3-2-1 presentation: empty wells behind the countdown overlay,
    /// carrying the roster's names/colors/levels. Empty boards aren't fixture data
    /// (the fixture game snapshots hold dropped stacks), so build them here.
    private func showGalleryCountdown(players: Int) {
        let roster = seedGalleryRoster(count: players)
        let boards = roster.map { emptyBoard(id: $0.id, level: $0.level) }
        output?.showScreen(.game)
        output?.renderSnapshot(GameSnapshot(players: boards, elapsed: 0))
        // Freeze at "3" — the first number of the sequence, matching the web
        // harness's initial frame and the Android countdown shot.
        output?.showCountdown(.number(3))
    }

    /// Render a named board-variant snapshot, seating the roster names/colors first.
    private func showGalleryGame(variant: String) {
        guard let snap = try? galleryFixtures()?.gallerySnapshot(variant: variant) else { return }
        seedGalleryRoster(count: snap.players.count)
        output?.showScreen(.game)
        output?.renderSnapshot(snap)
    }

    /// The results overlay over the frozen (blurred) boards, exactly as a live
    /// end-of-match: `count` lv1-equivalent boards behind, ranked by results(count).
    private func showGalleryResults(count: Int) {
        guard let fx = galleryFixtures() else { return }
        if let snap = try? fx.gallerySnapshot(players: count, level: 1) {
            seedGalleryRoster(count: snap.players.count)
            output?.showScreen(.game)
            output?.renderSnapshot(snap)
        }
        guard let bundle = try? fx.galleryResults(count: count) else { return }
        let out: [[String: Any]] = bundle.results.map { r in
            ["playerId": r.playerId, "playerName": r.playerName, "colorIndex": r.colorIndex,
             "rank": r.rank, "lines": r.lines, "level": r.level]
        }
        output?.showResults(out)
        output?.showScreen(.results)
    }

    private func emptyBoard(id: Int, level: Int) -> PlayerSnapshot {
        let grid = Array(repeating: Array(repeating: 0, count: EngineConstants.cols),
                         count: EngineConstants.visibleRows)
        return PlayerSnapshot(id: id, grid: grid, currentPiece: nil, ghost: nil, holdPiece: nil,
                              nextPieces: [], level: level, lines: 0, alive: true,
                              pendingGarbage: 0, clearingCells: nil, gridVersion: 1)
    }

    /// The cross-device rejoin URL a dropped board's QR encodes: `base` (JOIN.qrText)
    /// with the production `?claim=<peerIndex>` spliced in before any fragment
    /// (mirrors the web showDisconnectQR).
    private func galleryRejoinURL(_ base: String, claim: Int) -> String {
        let head: Substring, hash: Substring
        if let h = base.firstIndex(of: "#") { head = base[..<h]; hash = base[h...] }
        else { head = Substring(base); hash = "" }
        let sep = head.contains("?") ? "&" : "?"
        return "\(head)\(sep)claim=\(claim)\(hash)"
    }

    private func driveDemoInput() {
        demoTick += 1
        let actions = ["left", "right", "rotate_cw", "right", "rotate_cw", "left"]
        for (i, id) in playerOrder.enumerated() {
            let phase = demoTick + i * 5
            if phase % 7 == 0 { engine?.processInput(playerId: id, action: actions[(phase / 7) % actions.count]) }
            if phase % 24 == 0 { engine?.processInput(playerId: id, action: "hard_drop") }
        }
        if engine?.isEnded == true { /* will transition to results next tick */ }
    }

    // MARK: - Outbound builders

    private func broadcastLobby() {
        for p in flow.list() { sendLobbyUpdate(to: p.peerIndex) }
        refreshDisplayLobby()
        lastBroadcastedHostId = flow.host   // so maybeBroadcastHostChange won't re-fire
    }

    /// Rebuild the display's own lobby UI from the current roster. Needed because
    /// name/color/level changes mutate records in place and don't fire
    /// onRosterChange, which is what the display lobby otherwise listens to.
    private func refreshDisplayLobby() {
        output?.updateLobby(players: flow.list(), hostPeerIndex: flow.host)
    }

    private func sendLobbyUpdate(to id: Int) {
        guard let rec = flow.player(id) else { return }
        let host = flow.host
        // Build the payload omitting nil optionals rather than coercing them with
        // `as Any` (Optional.none as Any is a JSONSerialization footgun that can
        // throw and silently drop the whole message in sendEnvelope).
        var msg: [String: Any] = [
            "type": MSG.lobbyUpdate,
            "playerCount": flow.size,
            "startLevel": rec.startLevel,
            "isHost": id == host,
            "colorIndex": rec.colorSlot,
            "takenColorIndices": flow.takenColorSlots(),
        ]
        if let hostName = host.flatMap({ flow.player($0)?.playerName }) { msg["hostName"] = hostName }
        if let hostColor = host.flatMap({ flow.player($0)?.colorSlot }) { msg["hostColorIndex"] = hostColor }
        transport.sendTo(id, msg)
    }

    private func sendWelcome(to id: Int, isLateJoiner: Bool) {
        guard let rec = flow.player(id) else { return }
        let host = flow.host
        var welcome: [String: Any] = [
            "type": MSG.welcome,
            "playerName": rec.playerName,
            "colorIndex": rec.colorSlot,
            "playerCount": flow.size,
            "roomState": flow.state.rawValue,
            "startLevel": rec.startLevel,
            "isHost": id == host,
            "takenColorIndices": flow.takenColorSlots(),
            "displayMuted": muted,
        ]
        // Omit nil host fields rather than `as Any`-coercing them (see sendLobbyUpdate).
        if let hostName = host.flatMap({ flow.player($0)?.playerName }) { welcome["hostName"] = hostName }
        if let hostColor = host.flatMap({ flow.player($0)?.colorSlot }) { welcome["hostColorIndex"] = hostColor }
        // Report the participant's real alive state (false once KO'd) so a
        // reconnecting eliminated phone stays on its game-over screen instead of
        // flipping back to the live playing UI (web parity: lastAliveState).
        if !isLateJoiner { welcome["alive"] = aliveState[id] ?? true; welcome["paused"] = paused }
        // Replay the finished ranking to a controller landing on RESULTS.
        if flow.state == .results, let lastResults { welcome["results"] = lastResults }
        transport.sendTo(id, welcome)
    }

    private func enrichResults(_ results: [PlayerResult]) -> [[String: Any]] {
        var out: [[String: Any]] = []
        var rankedIds = Set<Int>()
        for r in results {
            rankedIds.insert(r.playerId)
            var e: [String: Any] = [
                "playerId": r.playerId, "alive": r.alive, "lines": r.lines,
                "level": r.level, "rank": r.rank,
            ]
            if let rec = flow.player(r.playerId) {
                e["playerName"] = rec.playerName
                e["colorIndex"] = rec.colorSlot
            }
            out.append(e)
        }
        // Late joiners who sat out.
        for rec in flow.list() where !rankedIds.contains(rec.peerIndex) {
            out.append(["playerId": rec.peerIndex, "playerName": rec.playerName,
                        "colorIndex": rec.colorSlot, "newPlayer": true])
        }
        return out
    }

    // MARK: - Helpers

    private func pruneDisconnected() {
        for rec in flow.list() where flow.isDisconnected(rec.peerIndex) {
            flow.removePlayer(rec.peerIndex)
            playerOrder.removeAll { $0 == rec.peerIndex }
        }
    }

    private func autoName(slot: Int) -> String { "HX-\(slot + 1)" }

    private func sanitizeName(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let stripped = raw.unicodeScalars.filter { !$0.properties.isDefaultIgnorableCodePoint && $0 >= " " }
        var s = String(String.UnicodeScalarView(stripped)).trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { return nil }
        if s.count > 16 { s = String(s.prefix(16)) }
        return s
    }

    private func joinURL(room: String, instance: String?) -> String {
        var url = "\(Protocol.controllerBaseURL)/\(room)"
        if let instance, !instance.isEmpty { url += "#\(instance)" }
        return url
    }

    /// Cross-device rejoin URL for a dropped participant (carries ?claim=<idx>).
    private func rejoinURL(_ peerIndex: Int) -> String {
        guard let room else { return "" }
        var url = "\(Protocol.controllerBaseURL)/\(room)?claim=\(peerIndex)"
        if let instance, !instance.isEmpty { url += "#\(instance)" }
        return url
    }
}
