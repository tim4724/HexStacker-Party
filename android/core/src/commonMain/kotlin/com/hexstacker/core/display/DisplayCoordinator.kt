package com.hexstacker.core.display

import com.hexstacker.core.engine.EngineBridge
import com.hexstacker.core.engine.InputAction
import com.hexstacker.core.net.Fastlane
import com.hexstacker.core.model.Command
import com.hexstacker.core.model.CommandType
import com.hexstacker.core.model.PlayerResult
import com.hexstacker.core.net.ControllerMessage
import com.hexstacker.core.net.Msg
import com.hexstacker.core.net.OutboundMessage
import com.hexstacker.core.net.RelayConfig
import com.hexstacker.core.net.RelayTransport
import com.hexstacker.core.net.RoomState
import com.hexstacker.core.room.RoomFlow
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlin.random.Random
import kotlin.time.DurationUnit
import kotlin.time.TimeSource

/**
 * The native display brain: owns the relay transport, the [RoomFlow] roster, and
 * the engine; implements the display-side protocol handling and game lifecycle
 * (lobby -> countdown -> playing -> results). A port of `DisplayCoordinator.swift`
 * (itself a port of the `DisplayGame.js` / `DisplayInput.js` / `DisplayConnection.js`
 * slice), with the Swift sync `tick` becoming a `suspend` engine-driven tick.
 *
 * Threading (the Kotlin analogue of Swift's "everything on .main"): every inbound
 * relay callback, every remote-control action, and every [tick] is funnelled
 * through ONE [Channel] consumed by a single coroutine on [scope]'s
 * single-thread dispatcher. The consumer is the only thing that mutates
 * [RoomFlow], [playerOrder], [paused], the countdown counters, and the engine
 * handle, so there is no shared-state race and engine calls can suspend without
 * interleaving (see the spec's §8.14). [tick] / [awaitIdle] enqueue and await an
 * ack, so callers observe a settled state when they return.
 *
 * commonMain-only: depends on [RelayTransport] (interface), [EngineBridge],
 * the models, kotlinx.serialization.json and kotlinx.coroutines. No OkHttp / no
 * android.* — the concrete relay client lives in the Relay sibling subsystem.
 */
class DisplayCoordinator(
    private val transport: RelayTransport,
    private val output: DisplayOutput,
    /** (specs, seed) -> a created+inited EngineBridge. Supplied by :tv / tests. */
    private val engineFactory: suspend (players: List<EngineBridge.PlayerSpec>, seed: Long) -> EngineBridge,
    /** 32-bit unsigned seed in 0..0xFFFFFFFF; the engine applies `>>> 0`. */
    private val seedProvider: () -> Long = { Random.nextLong(0, 0x1_0000_0000L) },
    /** Optional WebRTC low-latency input path (relay is the fallback). Null = relay-only. */
    private val fastlane: Fastlane? = null,
    dispatcher: CoroutineDispatcher = Dispatchers.Default.limitedParallelism(1),
) {
    // Liveness on: controllers ping at 1 Hz, so a 3s silence (constants.js
    // LIVENESS_TIMEOUT_MS) marks them disconnected even without a clean peer_left.
    val flow = RoomFlow(
        livenessTimeoutMs = 3000.0,
        graceMs = 5000.0,
        livenessEnabledProvider = { true },
    )
    val state: RoomState get() = flow.state
    val isMuted: Boolean get() = muted

    private val job = SupervisorJob()
    private val scope = CoroutineScope(job + dispatcher)
    private val actions = Channel<Action>(Channel.UNLIMITED)
    private var started = false

    private var engine: EngineBridge? = null
    private var room: String? = null
    private var instance: String? = null

    private var paused = false
    // Auto-pause (all game participants dropped mid-game) — distinct from a manual/remote
    // pause so a reconnect can auto-resume. Mirrors DisplayGame.js `autoPaused`.
    private var autoPaused = false
    // Set while the DISPLAY's own relay link is down; pauses the running game until we
    // reconnect (controllers are unreachable, so no broadcast). Web pauses on link drop.
    private var linkPaused = false
    // Monotonic clock fed to engine.frame(); only deltas matter, so it never needs
    // resetting across games (a fresh EngineBridge re-primes on its first frame()).
    private var frameClockMs = 0.0
    private var playerOrder = mutableListOf<Int>()
    private var pendingSeed = 0L
    private var demoSeedOverride: Long? = null
    private var muted = false
    // Host-change dedup for the mid-game handoff re-broadcast (web maybeBroadcastHostChange).
    private var lastBroadcastedHost: Int? = null
    // Retained results (replayed to a controller that (re)connects during RESULTS) + the
    // last-known alive of each participant (so a mid-game reconnect's WELCOME is accurate).
    private var lastResultsJson: JsonArray? = null
    private val aliveState = HashMap<Int, Boolean>()

    // Countdown driven by accumulated frame time (deterministic + testable).
    private var countdownElapsed = 0.0
    private var countdownStep = -1 // -1 init; 0->3, 1->2, 2->1, 3->GO, 4->start

    // Liveness: accumulates tick time to run a ~1 Hz expiredPeers() sweep.
    private var livenessAccumMs = 0.0

    // Monotonic source for the diagnostics-only lastPingTime (commonMain-safe; the
    // Swift port used Date().timeIntervalSince1970, but nothing in this subsystem
    // reads the value, so a monotonic ms reading is equivalent for the contract).
    private val epoch = TimeSource.Monotonic.markNow()

    // Injectable wall clock (deterministic liveness/grace in tests). Null -> monotonic epoch.
    internal var clock: (() -> Double)? = null

    companion object {
        private const val STEP_MS = 1000.0   // DisplayCoordinator.swift stepMs
        private const val GO_HOLD_MS = 500.0 // goHoldMs (web GO->start setTimeout 500)
        private const val NAME_MAX_LEN = 16
        private const val START_LEVEL_MIN = 1
        private const val START_LEVEL_MAX = 15

        // Auto-name pool: HX-N with the web's culturally/content blocklist (DisplayState.js).
        private val AUTO_NAME_BLOCKLIST = setOf(4, 13, 17, 69)
        private val AUTO_NAME_RE = Regex("^HX-([1-9][0-9]?)$", RegexOption.IGNORE_CASE)
        private val LEGACY_SLOT_RE = Regex("^P[1-8]$", RegexOption.IGNORE_CASE)
    }

    // =====================================================================
    // Action plumbing
    // =====================================================================

    private enum class RemoteKind { START_MATCH, RETURN_TO_LOBBY, TOGGLE_PAUSE, PLAY_PAUSE, TOGGLE_MUTE }

    private sealed interface Action {
        data class Created(val room: String, val instance: String?) : Action
        data class Joined(val room: String, val peers: List<Int>) : Action
        data class PeerJoined(val index: Int) : Action
        data class PeerLeft(val index: Int) : Action
        data class Message(val from: Int, val data: JsonObject) : Action
        data class RelayError(val message: String) : Action
        data class Tick(val deltaMs: Double, val ack: CompletableDeferred<Unit>) : Action
        data class Remote(val kind: RemoteKind, val ack: CompletableDeferred<Boolean>?) : Action
        data class Link(val state: RelayTransport.ConnectionState) : Action
        data class Barrier(val ack: CompletableDeferred<Unit>) : Action
    }

    /** Wire transport + flow callbacks and start the single action consumer. */
    fun start() {
        if (started) return
        started = true
        transport.onCreated = { room, instance, _ -> actions.trySend(Action.Created(room, instance)) }
        transport.onJoined = { room, peers -> actions.trySend(Action.Joined(room, peers)) }
        transport.onPeerJoined = { idx -> actions.trySend(Action.PeerJoined(idx)) }
        transport.onPeerLeft = { idx -> actions.trySend(Action.PeerLeft(idx)) }
        transport.onMessage = { from, data -> actions.trySend(Action.Message(from, data)) }
        transport.onRelayError = { msg -> actions.trySend(Action.RelayError(msg)) }
        flow.onRosterChange = { players -> output.updateLobby(players, flow.host) }
        // Fast-lane: decoded P2P inputs enter the SAME single-consumer queue as relay
        // messages (identical handling); its signaling answers ride the relay back.
        fastlane?.let { fl ->
            fl.onInput = { from, data -> actions.trySend(Action.Message(from, data)) }
            fl.sendSignal = { to, data -> transport.sendTo(to, data) }
        }
        scope.launch { consume() }
        transport.connect()
    }

    /** Cancel the consumer + scope and disconnect the transport. */
    fun stop() {
        if (!started) return
        // Tell controllers the display is going away so they show the end screen
        // immediately instead of a reconnect overlay (web broadcasts DISPLAY_CLOSED).
        runCatching { transport.broadcast(OutboundMessage.displayClosed()) }
        fastlane?.closeAll()
        transport.disconnect()
        actions.close()
        scope.cancel()
    }

    /**
     * Feed the DISPLAY's own relay-link state in (the app already surfaces it for the
     * reconnect overlay). A drop pauses the running game until we reconnect — mirrors the
     * web pausing on its own link loss. Runs on the single consumer so it can't race the FSM.
     */
    fun onLinkStateChanged(state: RelayTransport.ConnectionState) {
        actions.trySend(Action.Link(state))
    }

    private suspend fun consume() {
        for (action in actions) {
            try {
                when (action) {
                    is Action.Created -> handleCreated(action.room, action.instance)
                    is Action.Joined -> handleJoined(action.room, action.peers)
                    is Action.PeerJoined -> onPeerJoined(action.index)
                    is Action.PeerLeft -> onPeerLeft(action.index)
                    is Action.Message -> onMessage(action.from, action.data)
                    is Action.RelayError -> onRelayError(action.message)
                    is Action.Tick -> try {
                        tickLocked(action.deltaMs)
                    } finally {
                        action.ack.complete(Unit)
                    }
                    is Action.Link -> onLinkState(action.state)
                    is Action.Barrier -> action.ack.complete(Unit)
                    is Action.Remote -> {
                        var result = false
                        try {
                            result = handleRemote(action.kind)
                        } finally {
                            action.ack?.complete(result)
                        }
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                // Keep the consumer alive: a parse/engine error must not stop the loop.
            }
        }
    }

    /** Drive one frame. The render loop calls this every display tick with the real delta. */
    suspend fun tick(deltaMs: Double) {
        val ack = CompletableDeferred<Unit>()
        // trySend (the channel is UNLIMITED, so this only fails when it is closed): a tick
        // racing stop() is dropped rather than throwing ClosedSendChannelException.
        if (actions.trySend(Action.Tick(deltaMs, ack)).isSuccess) ack.await()
    }

    /** Suspend until every action enqueued so far has been processed (testing/UI sync). */
    suspend fun awaitIdle() {
        val ack = CompletableDeferred<Unit>()
        if (actions.trySend(Action.Barrier(ack)).isSuccess) ack.await()
    }

    // =====================================================================
    // Connection lifecycle
    // =====================================================================

    private fun handleCreated(room: String, instance: String?) {
        this.room = room
        this.instance = instance
        output.roomReady(room, joinUrl(room, instance))
        output.showScreen(DisplayScreen.LOBBY)
    }

    private suspend fun handleJoined(room: String, peers: List<Int>) {
        // The DISPLAY's own relay reconnect: reconcile the roster and re-welcome.
        this.room = room
        // Re-stamp liveness for surviving peers, collecting the gone ones for onPeerLeft.
        // Mirrors onDisplayRejoined: a survivor whose last ping predates the display's link
        // drop must not be expired by the first liveness tick after reconnect, so refresh
        // presence for every peer still in the relay's list. Peers absent from that list are
        // gone, routed through the state-aware onPeerLeft (removes in LOBBY/RESULTS, keeps +
        // disconnect-overlay mid-game). Snapshot first: onPeerLeft mutates the roster.
        val now = nowWallMs()
        val gone = mutableListOf<Int>()
        for (p in flow.list()) {
            if (p.peerIndex in peers) flow.onSeen(p.peerIndex, now) else gone.add(p.peerIndex)
        }
        for (id in gone) onPeerLeft(id)
        // Re-welcome survivors, computing late-joiner status per peer (a mid-game late joiner
        // must NOT receive alive/paused, so their controller stays on the waiting screen).
        for (p in flow.list()) {
            val late = (flow.state == RoomState.PLAYING || flow.state == RoomState.COUNTDOWN) &&
                !playerOrder.contains(p.peerIndex)
            sendWelcome(p.peerIndex, isLateJoiner = late)
        }
        // The link-drop pause lifts only now that the room-level rejoin reconciled the roster
        // (resumeGame's allParticipantsDisconnected guard sees the post-reconcile truth and the
        // GAME_RESUMED broadcast can't outrun the relay's join processing).
        if (linkPaused) {
            linkPaused = false
            resumeGame()
        }
    }

    private fun onPeerJoined(index: Int) {
        val slot = flow.lowestFreeSlot()
        if (slot < 0) {
            transport.sendTo(index, OutboundMessage.error("Room is full"))
            return
        }
        flow.addPlayer(index, autoName(), slot)
        if (flow.state == RoomState.LOBBY) broadcastLobby()
    }

    private suspend fun onPeerLeft(index: Int) {
        fastlane?.close(index) // the P2P link died with the controller; it re-offers on reconnect
        when (flow.state) {
            RoomState.LOBBY -> {
                flow.removePlayer(index)
                playerOrder.removeAll { it == index }
                if (flow.size > 0) broadcastLobby()
            }
            RoomState.RESULTS -> {
                // Drop the leaver from roster + participant order; return to lobby once no
                // game participant remains (late joiners don't count), else refresh the host.
                flow.removePlayer(index)
                playerOrder.removeAll { it == index }
                flow.setActiveOrder(playerOrder)
                val hasParticipants = playerOrder.any { flow.contains(it) }
                if (!hasParticipants) {
                    lastResultsJson = null
                    returnToLobby()
                } else if (flow.size > 0) {
                    broadcastLobby()
                }
            }
            RoomState.COUNTDOWN, RoomState.PLAYING ->
                if (playerOrder.contains(index)) {
                    flow.markDisconnected(index) // keep slot for a seamless reconnect
                    output.setDisconnected(index, rejoinUrl(index))
                    checkAllParticipantsDisconnected()
                    // The stored host doesn't move mid-game, but if the departing player WAS
                    // the effective host, re-broadcast so a remaining controller's pause-overlay
                    // Return-to-lobby button appears. Skip when everyone is gone (nobody to notify).
                    if (!flow.allParticipantsDisconnected()) maybeBroadcastHostChange()
                } else {
                    flow.removePlayer(index)
                }
        }
    }

    /**
     * 1 Hz liveness sweep: a controller silent past LIVENESS_TIMEOUT_MS is only marked
     * disconnected and shown a per-board rejoin QR, NOT removed from the roster. Mirrors
     * DisplayLiveness.js (showDisconnectQR + checkAllPlayersDisconnected + maybeBroadcast
     * HostChange); the heavier roster-removal path (onPeerLeft) is reserved for a real
     * relay peer_left. Reusing onPeerLeft here would evict a silent late joiner during a
     * game and remove a peer / return to lobby from a mere timeout during RESULTS, neither
     * of which the web does. `expiredPeers` gates out the LOBBY and already-disconnected
     * peers; a controller that pings again is reconnected in [onMessage].
     */
    private suspend fun checkLiveness() {
        val expired = flow.expiredPeers(nowWallMs())
        if (expired.isEmpty()) return
        for (id in expired) {
            fastlane?.close(id) // the P2P link died with the controller; it re-offers on reconnect
            flow.markDisconnected(id) // keep the slot for a seamless reconnect
            output.setDisconnected(id, rejoinUrl(id))
        }
        checkAllParticipantsDisconnected() // no-ops outside PLAYING; arms grace / auto-pauses mid-game
        if (!flow.allParticipantsDisconnected()) maybeBroadcastHostChange()
    }

    /**
     * All game participants dropped mid-game: return to lobby if the late-joiner grace
     * window has fired, else silently auto-pause (no overlay, no broadcast — every
     * controller is gone). Port of DisplayGame.js `checkAllPlayersDisconnected`.
     */
    private suspend fun checkAllParticipantsDisconnected() {
        if (flow.state != RoomState.PLAYING) return // don't auto-pause during COUNTDOWN
        if (!flow.allParticipantsDisconnected()) return
        if (flow.graceTick(nowWallMs())) { returnToLobby(); return }
        if (paused) return
        paused = true
        autoPaused = true
        engine?.pause()
        engine?.resetFrameClock()
        output.pauseMusic()
    }

    /** A participant reconnected while auto-paused: resume. Port of `checkAutoResume`. */
    private suspend fun checkAutoResume() {
        if (!autoPaused) return
        autoPaused = false
        resumeGame()
    }

    /** Re-broadcast the roster iff the effective host changed (web `maybeBroadcastHostChange`). */
    private fun maybeBroadcastHostChange() {
        if (flow.size == 0) return
        if (flow.host == lastBroadcastedHost) return
        broadcastLobby()
    }

    /**
     * The display's own relay link state. On a drop, pause the running game (controllers
     * are unreachable, so no broadcast). The resume lives in [handleJoined], not here: OPEN
     * fires at raw-socket-open, before the relay has processed our join, so resuming (and
     * broadcasting GAME_RESUMED) now could race ahead of the roster reconciliation and be
     * dropped server-side. The web equivalent (onDisplayRejoined) also resumes only after
     * the relay's `joined` reply.
     */
    private suspend fun onLinkState(state: RelayTransport.ConnectionState) {
        when (state) {
            RelayTransport.ConnectionState.RECONNECTING, RelayTransport.ConnectionState.CLOSED -> {
                val active = flow.state == RoomState.PLAYING || flow.state == RoomState.COUNTDOWN
                if (active && !paused) {
                    paused = true
                    linkPaused = true
                    if (flow.state == RoomState.PLAYING) { // COUNTDOWN: the engine isn't ticking yet
                        engine?.pause()
                        engine?.resetFrameClock()
                    }
                    output.pauseMusic()
                }
            }
            else -> {}
        }
    }

    // =====================================================================
    // Inbound messages
    // =====================================================================

    private suspend fun onMessage(from: Int, data: JsonObject) {
        // Fast-lane signaling (offer/ice) rides the relay tagged with __rtc — hand it to the
        // fastlane and stop (it isn't an app message). Decoded P2P inputs re-enter as messages.
        if (fastlane != null && Fastlane.isSignal(data)) {
            fastlane.handleSignal(from, data)
            return
        }
        val msg = ControllerMessage.from(data) ?: return
        val now = nowWallMs()
        flow.player(from)?.lastPingTime = now
        flow.onSeen(from, now) // liveness: every controller message refreshes presence
        if (flow.isDisconnected(from)) {
            flow.markReconnected(from)
            output.setDisconnected(from, null) // clear rejoin overlay
            checkAutoResume() // a participant is back -> lift a silent all-disconnect pause
        }
        when (msg.type) {
            Msg.HELLO -> handleHello(from, msg)
            Msg.INPUT -> handleInput(from, msg)
            Msg.SOFT_DROP -> if (flow.state == RoomState.PLAYING && !paused) engine?.softDropStart(from, msg.speed?.toInt())
            Msg.SOFT_DROP_END -> if (flow.state == RoomState.PLAYING) engine?.softDropEnd(from)
            Msg.START_GAME -> if (flow.state == RoomState.LOBBY && flow.size >= 1) beginCountdown()
            Msg.PLAY_AGAIN -> if (flow.state == RoomState.RESULTS && flow.size >= 1) beginCountdown()
            Msg.RETURN_TO_LOBBY -> returnToLobby()
            Msg.PAUSE_GAME -> pauseGame()
            Msg.RESUME_GAME -> resumeGame()
            Msg.LEAVE -> onPeerLeft(from)
            Msg.SET_LEVEL -> handleSetLevel(from, msg)
            Msg.SET_COLOR -> handleSetColor(from, msg)
            Msg.SET_NAME -> handleSetName(from, msg)
            Msg.SET_DISPLAY_MUTE -> handleSetMute(from, msg)
            Msg.PING -> transport.sendTo(from, OutboundMessage.pong(msg.t))
            else -> {}
        }
    }

    private suspend fun handleHello(from: Int, msg: ControllerMessage) {
        // Cross-device claim: a returning controller (new peerIndex) reclaims a dropped
        // participant's board via the ?claim= rejoin QR. Handle before the new-player path.
        if (tryClaimReconnect(from, msg)) {
            sendWelcome(from, isLateJoiner = false) // now a live participant on the reclaimed board
            maybeBroadcastHostChange()
            if (flow.state == RoomState.LOBBY || flow.state == RoomState.RESULTS) broadcastLobby()
            return
        }
        if (flow.player(from) == null) {
            val slot = flow.lowestFreeSlot()
            if (slot < 0) {
                transport.sendTo(from, OutboundMessage.error("Room is full"))
                return
            }
            // autoName=true re-resolves through the room-unique generator even when the
            // submitted HX name sanitizes fine, so a rejoining controller can't duplicate
            // another player's name (web sanitizePlayerName with requestedAutoName).
            val name = if (msg.autoName == true) autoName(msg.name) else (sanitizeName(msg.name) ?: autoName(msg.name))
            flow.addPlayer(from, name, slot)
        } else {
            // Mirror web onHello's existing-player branch: a non-empty submission or an
            // autoName request re-resolves via sanitizePlayerName (auto/empty/legacy names
            // go through the generator, excluding this peer's own entry so an unchanged
            // HX name keeps its number); custom names apply as entered.
            val rec = flow.player(from)!!
            val submitted = !msg.name.isNullOrBlank()
            if (msg.autoName == true || submitted) {
                val requested = if (submitted) msg.name else rec.playerName
                val cleaned = sanitizeName(requested)
                rec.playerName =
                    if (msg.autoName == true || cleaned == null) autoName(requested, exceptId = from) else cleaned
            }
        }
        val late = (flow.state == RoomState.PLAYING || flow.state == RoomState.COUNTDOWN) &&
            !playerOrder.contains(from)
        sendWelcome(from, isLateJoiner = late)
        if (flow.state == RoomState.LOBBY || flow.state == RoomState.RESULTS) broadcastLobby()
    }

    /**
     * Reclaim a dropped participant's slot for a returning controller with a NEW peerIndex
     * (phone reload / handoff). Port of DisplayConnection.js `claimReconnectPeer`: rekeys the
     * roster (RoomFlow.rekey, which also drops the returning peer's placeholder slot), the
     * engine board (EngineBridge.rekey), the participant order, and the alive/overlay state.
     * Returns false (no-op) unless oldId is a currently-disconnected participant.
     */
    private suspend fun tryClaimReconnect(from: Int, msg: ControllerMessage): Boolean {
        val oldId = msg.rejoinToken ?: msg.rejoinId ?: msg.claim ?: return false
        if (oldId == from) return false
        if (!flow.contains(oldId) || !flow.isDisconnected(oldId)) return false
        if (!playerOrder.contains(oldId)) return false
        if (!flow.rekey(oldId, from)) return false
        flow.onSeen(from, nowWallMs())
        fastlane?.close(oldId) // drop the dropped device's P2P link; the returning device re-offers
        engine?.let { runCatching { it.rekey(oldId, from) } } // engine is null in RESULTS (roster-only claim)
        for (i in playerOrder.indices) if (playerOrder[i] == oldId) playerOrder[i] = from
        flow.setActiveOrder(playerOrder)
        aliveState.remove(oldId)?.let { aliveState[from] = it }
        output.setDisconnected(oldId, null) // clear the dropped board's rejoin overlay
        output.setDisconnected(from, null)
        checkAutoResume() // a participant is back -> lift a silent all-disconnect pause
        return true
    }

    private suspend fun handleInput(from: Int, msg: ControllerMessage) {
        if (flow.state != RoomState.PLAYING || paused) return
        val action = msg.action ?: return
        val input = InputAction.fromWire(action) ?: return
        engine?.processInput(from, input)
    }

    private fun handleSetLevel(from: Int, msg: ControllerMessage) {
        val level = msg.level ?: return
        if (level !in START_LEVEL_MIN..START_LEVEL_MAX) return
        val rec = flow.player(from) ?: return
        rec.startLevel = level
        if (flow.state == RoomState.LOBBY) {
            sendLobbyUpdate(from)
            refreshDisplayLobby()
        }
    }

    private fun handleSetColor(from: Int, msg: ControllerMessage) {
        val slot = msg.colorIndex ?: return
        if (slot !in 0 until RoomFlow.MAX_PLAYERS) return
        val rec = flow.player(from) ?: return
        if (flow.list().any { it.peerIndex != from && it.colorSlot == slot }) return // taken
        rec.colorSlot = slot
        broadcastLobby()
    }

    private fun handleSetName(from: Int, msg: ControllerMessage) {
        val name = sanitizeName(msg.name) ?: return
        val rec = flow.player(from) ?: return
        rec.playerName = name
        if (from == flow.host) broadcastLobby()
        else if (flow.state == RoomState.LOBBY || flow.state == RoomState.RESULTS) refreshDisplayLobby()
    }

    private fun handleSetMute(from: Int, msg: ControllerMessage) {
        if (from != flow.host) return
        muted = (msg.muted == true)
        transport.broadcast(OutboundMessage.displayMuted(muted))
        output.setMuted(muted) // actually silence/restore the TV music
    }

    // =====================================================================
    // Countdown + game
    // =====================================================================

    private suspend fun beginCountdown() {
        if (!flow.transitionTo(RoomState.COUNTDOWN)) return
        pruneDisconnected()
        // Everyone who remained was disconnected: don't build a zero-player engine. Mirrors
        // startNewGame's `players.size < 1` guard (a play-again / remote-start where only
        // disconnected participants remain returns to the lobby instead of launching an empty match).
        if (flow.size == 0) {
            returnToLobby()
            return
        }
        // Re-stamp lastSeen on this "everyone present" transition so a controller that went quiet
        // just before the match isn't instantly flagged by the first COUNTDOWN liveness sweep
        // (startNewGame calls flow.clearDisconnected(Date.now())). pruneDisconnected already dropped
        // the disconnected players, so this only refreshes presence for the survivors.
        flow.clearDisconnected(nowWallMs())
        // Late joiners enter the participant order, sorted by join time (leftmost = first joiner).
        for (id in flow.list().map { it.peerIndex }) if (id !in playerOrder) playerOrder.add(id)
        playerOrder = playerOrder.filter { flow.contains(it) }.toMutableList()
        playerOrder.sortBy { flow.player(it)?.joinedAt ?: Int.MAX_VALUE }
        flow.setActiveOrder(playerOrder)
        pendingSeed = demoSeedOverride ?: seedProvider()
        paused = false
        autoPaused = false
        linkPaused = false
        aliveState.clear()
        countdownElapsed = 0.0
        countdownStep = -1
        if (!makeEngine()) {
            returnToLobby()
            return
        }
        // Empty boards behind the 3-2-1 overlay: the web nulls its render state during
        // COUNTDOWN (onCountdownDisplay sets gameState = null) so pieces/ghost appear only at
        // GO. showScreen(GAME) resets the boards; the first snapshot renders once PLAYING ticks.
        output.showScreen(DisplayScreen.GAME)
    }

    private suspend fun makeEngine(): Boolean {
        val specs = playerOrder.map { EngineBridge.PlayerSpec(it, flow.player(it)?.startLevel ?: 1) }
        return try {
            engine = engineFactory(specs, pendingSeed)
            true
        } catch (e: Throwable) {
            false
        }
    }

    private suspend fun startPlaying() {
        flow.transitionTo(RoomState.PLAYING)
        transport.broadcast(OutboundMessage.gameStart())
        // JS startNewGame's onComplete calls checkAllPlayersDisconnected() right after entering
        // PLAYING (DisplayGame.js): if everyone dropped during COUNTDOWN the match must pause (or
        // return to lobby via the grace window) instead of starting unpaused and playing itself out.
        checkAllParticipantsDisconnected()
    }

    private suspend fun tickLocked(rawDelta: Double) {
        // Only sanitize negatives/NaN here; do NOT clamp to MAX_FRAME_DELTA_MS.
        // The engine's frame() applies that cap itself (per its contract), and the
        // countdown must advance by real elapsed time (a 1000ms tick is one second
        // of countdown, not 50ms).
        val deltaMs = if (rawDelta.isFinite()) rawDelta.coerceAtLeast(0.0) else 0.0
        livenessAccumMs += deltaMs
        if (livenessAccumMs >= 1000.0) {
            livenessAccumMs = 0.0
            checkLiveness()
            // Late-joiner grace: if the whole roster dropped mid-game and someone's waiting,
            // return to lobby once the 5s window elapses (RoomFlow arms + fires this poll).
            if (flow.graceTick(nowWallMs())) returnToLobby()
        }
        when (flow.state) {
            RoomState.COUNTDOWN -> advanceCountdown(deltaMs)
            RoomState.PLAYING -> {
                if (paused) return
                val e = engine ?: return
                frameClockMs += deltaMs
                val frame = try {
                    e.frame(frameClockMs)
                } catch (t: Throwable) {
                    return
                }
                for (ev in frame.events) output.handleGameEvent(ev) // board animations
                output.renderSnapshot(frame.snapshot) // snapshot carries music level
                dispatchCommands(frame.commands) // host effects -> sends + match end
            }
            RoomState.LOBBY, RoomState.RESULTS -> {}
        }
    }

    private suspend fun advanceCountdown(deltaMs: Double) {
        if (countdownStep < 0) {
            emitCountdownStep(0) // step 0 fires immediately at entry (even if paused)
            return
        }
        if (paused) return // a mid-countdown pause freezes the count (web clearCountdownTimers)
        countdownElapsed += deltaMs
        val nextStep = countdownStep + 1
        val threshold = if (nextStep <= 3) nextStep * STEP_MS else 3 * STEP_MS + GO_HOLD_MS
        if (countdownElapsed >= threshold) emitCountdownStep(nextStep)
    }

    private suspend fun emitCountdownStep(step: Int) {
        countdownStep = step
        when (step) {
            0 -> {
                transport.broadcast(OutboundMessage.countdown(3))
                output.showCountdown(CountdownValue.Number(3))
                output.playCountdownBeep(false)
            }
            1 -> {
                transport.broadcast(OutboundMessage.countdown(2))
                output.showCountdown(CountdownValue.Number(2))
                output.playCountdownBeep(false)
            }
            2 -> {
                transport.broadcast(OutboundMessage.countdown(1))
                output.showCountdown(CountdownValue.Number(1))
                output.playCountdownBeep(false)
            }
            3 -> {
                transport.broadcast(OutboundMessage.countdownGo())
                output.showCountdown(CountdownValue.Go)
                output.playCountdownBeep(true)
                // Start even while muted: MusicPlayer.start() runs the loop at volume 0, so a
                // later unmute is instantly audible (web keeps the graph running when muted).
                output.startMusic()
            }
            else -> startPlaying()
        }
    }

    /** Map the frame's normalized host-effect commands to controller sends + match end. */
    private fun dispatchCommands(commands: List<Command>) {
        for (c in commands) {
            when (c.type) {
                CommandType.PLAYER_STATE -> {
                    val pid = c.playerId ?: continue
                    c.alive?.let { aliveState[pid] = it } // remembered for a mid-game reconnect's WELCOME
                    if (c.level != null && c.lines != null && c.alive != null) {
                        transport.sendTo(pid, OutboundMessage.playerState(c.level, c.lines, c.alive, c.garbageIncoming ?: 0))
                    } else if (c.alive == false) {
                        transport.sendTo(pid, OutboundMessage.playerDead()) // short form after KO
                    }
                }
                CommandType.PLAYER_ELIMINATED -> c.playerId?.let {
                    aliveState[it] = false
                    transport.sendTo(it, OutboundMessage.gameOver())
                }
                CommandType.GAME_END -> endGame(c.results ?: emptyList(), c.elapsed ?: 0.0)
                else -> {
                    // pieceLock / lineClear / playerKO / garbageCancelled / garbageSent are rendered
                    // from events; musicSpeed is carried by renderSnapshot.
                }
            }
        }
    }

    private fun endGame(results: List<PlayerResult>, elapsed: Double) {
        val enriched = enrichResults(results)
        flow.transitionTo(RoomState.RESULTS)
        output.stopMusic()
        output.setPaused(false) // MUST precede showResults (clears the focus menu)
        paused = false
        autoPaused = false
        linkPaused = false
        val arr = resultsToJsonArray(enriched)
        lastResultsJson = arr // replayed to any controller that (re)connects during RESULTS
        transport.broadcast(OutboundMessage.gameEnd(elapsed, arr))
        output.showResults(enriched)
        output.showScreen(DisplayScreen.RESULTS)
        engine = null
    }

    private fun returnToLobby() {
        if (flow.state == RoomState.LOBBY) return
        paused = false
        autoPaused = false
        linkPaused = false
        lastResultsJson = null
        aliveState.clear()
        engine = null
        output.stopMusic()
        output.setPaused(false)
        pruneDisconnected()
        playerOrder = mutableListOf()
        flow.clearDisconnected()
        flow.transitionTo(RoomState.LOBBY)
        broadcastLobby()
        transport.broadcast(OutboundMessage.returnToLobby(flow.size))
        output.showScreen(DisplayScreen.LOBBY)
    }

    /**
     * Relay protocol error. Port of the web's `error` case (DisplayConnection.js):
     * "Room not found" / "Room is full" after a display rejoin means the relay lost our
     * room while our link was down — the code on screen is dead (controllers get "Room
     * not found") and every roster entry is unreachable. The web resets to WELCOME and
     * creates a fresh room; the TV has no welcome screen, so reset straight to a
     * fresh-room lobby. Any other relay error is non-fatal (the web just warns).
     */
    private fun onRelayError(message: String) {
        if (message != "Room not found" && message != "Room is full") return
        resetSession()
    }

    /** Full session reset + a fresh room (web resetToWelcome -> connectAndCreateRoom). */
    private fun resetSession() {
        paused = false
        autoPaused = false
        linkPaused = false
        lastResultsJson = null
        aliveState.clear()
        engine = null
        fastlane?.closeAll()
        output.stopMusic()
        output.setPaused(false)
        playerOrder = mutableListOf()
        room = null
        instance = null
        flow.reset() // roster/liveness/host cleared, state -> LOBBY, fires onRosterChange
        output.showScreen(DisplayScreen.LOBBY)
        transport.createFresh() // handleCreated re-arms the room code + QR when `created` lands
    }

    /** Manual pause; allowed while PLAYING or mid-COUNTDOWN (web pauseGame). During
     *  COUNTDOWN the engine isn't ticking yet, so freezing [advanceCountdown] via
     *  [paused] is the whole freeze (web clearCountdownTimers). */
    private suspend fun pauseGame() {
        if (paused || (flow.state != RoomState.PLAYING && flow.state != RoomState.COUNTDOWN)) return
        paused = true
        if (flow.state == RoomState.PLAYING) {
            engine?.pause()
            engine?.resetFrameClock() // forget the frame clock so resume re-primes with delta 0
        }
        output.pauseMusic()
        output.setPaused(true)
        transport.broadcast(OutboundMessage.gamePaused())
    }

    private suspend fun resumeGame() {
        if (!paused || (flow.state != RoomState.PLAYING && flow.state != RoomState.COUNTDOWN)) return
        if (flow.allParticipantsDisconnected()) return // web canResumeGame
        paused = false
        if (flow.state == RoomState.COUNTDOWN) {
            // Web resume (startCountdown(callback, remaining)): the current number stays on
            // screen without a re-broadcast/beep and gets its FULL second again; a shown GO
            // re-arms the full 500ms hold. In the accumulator model that is a rewind to the
            // current step's start.
            if (countdownStep >= 0) countdownElapsed = countdownStep * STEP_MS
        } else {
            engine?.resume()
        }
        if (!muted) output.resumeMusic()
        output.setPaused(false)
        transport.broadcast(OutboundMessage.gameResumed())
    }

    // =====================================================================
    // Remote controls (Android TV D-pad / play-pause)
    // =====================================================================

    fun remoteStartMatch() {
        actions.trySend(Action.Remote(RemoteKind.START_MATCH, null))
    }

    fun remoteReturnToLobby() {
        actions.trySend(Action.Remote(RemoteKind.RETURN_TO_LOBBY, null))
    }

    suspend fun remoteTogglePause() {
        val ack = CompletableDeferred<Boolean>()
        if (actions.trySend(Action.Remote(RemoteKind.TOGGLE_PAUSE, ack)).isSuccess) ack.await()
    }

    fun remotePlayPause() {
        actions.trySend(Action.Remote(RemoteKind.PLAY_PAUSE, null))
    }

    /** Toggle the display's own music mute; returns the new muted state. */
    suspend fun remoteToggleMute(): Boolean {
        val ack = CompletableDeferred<Boolean>()
        return if (actions.trySend(Action.Remote(RemoteKind.TOGGLE_MUTE, ack)).isSuccess) ack.await() else false
    }

    private suspend fun handleRemote(kind: RemoteKind): Boolean = when (kind) {
        RemoteKind.START_MATCH -> {
            if ((flow.state == RoomState.LOBBY || flow.state == RoomState.RESULTS) && flow.size >= 1) beginCountdown()
            muted
        }
        RemoteKind.RETURN_TO_LOBBY -> {
            if (flow.state != RoomState.LOBBY) returnToLobby()
            muted
        }
        RemoteKind.TOGGLE_PAUSE -> {
            if (flow.state == RoomState.PLAYING || flow.state == RoomState.COUNTDOWN) {
                if (paused) resumeGame() else pauseGame()
            }
            paused
        }
        RemoteKind.PLAY_PAUSE -> {
            when (flow.state) {
                RoomState.LOBBY, RoomState.RESULTS -> if (flow.size >= 1) beginCountdown()
                RoomState.COUNTDOWN, RoomState.PLAYING -> if (paused) resumeGame() else pauseGame()
            }
            muted
        }
        RemoteKind.TOGGLE_MUTE -> {
            muted = !muted
            transport.broadcast(OutboundMessage.displayMuted(muted))
            output.setMuted(muted)
            muted
        }
    }

    // =====================================================================
    // Outbound builders
    // =====================================================================

    private fun broadcastLobby() {
        for (p in flow.list()) sendLobbyUpdate(p.peerIndex)
        lastBroadcastedHost = flow.host // keep the handoff dedup sentinel current
        refreshDisplayLobby()
    }

    /** Rebuild the display's own lobby UI (in-place field mutations don't fire onRosterChange). */
    private fun refreshDisplayLobby() {
        output.updateLobby(flow.list(), flow.host)
    }

    private fun sendLobbyUpdate(id: Int) {
        val rec = flow.player(id) ?: return
        val host = flow.host
        transport.sendTo(
            id,
            buildJsonObject {
                put("type", Msg.LOBBY_UPDATE)
                put("playerCount", flow.size)
                put("startLevel", rec.startLevel)
                put("isHost", id == host)
                put("hostName", host?.let { flow.player(it)?.playerName })
                put("hostColorIndex", host?.let { flow.player(it)?.colorSlot })
                put("colorIndex", rec.colorSlot)
                putJsonArray("takenColorIndices") { flow.takenColorSlots().forEach { add(it) } }
            },
        )
    }

    private fun sendWelcome(id: Int, isLateJoiner: Boolean) {
        val rec = flow.player(id) ?: return
        val host = flow.host
        val welcome = buildJsonObject {
            put("type", Msg.WELCOME)
            put("playerName", rec.playerName)
            put("colorIndex", rec.colorSlot)
            put("playerCount", flow.size)
            put("roomState", flow.state.wire)
            put("startLevel", rec.startLevel)
            put("isHost", id == host)
            put("hostName", host?.let { flow.player(it)?.playerName })
            put("hostColorIndex", host?.let { flow.player(it)?.colorSlot })
            putJsonArray("takenColorIndices") { flow.takenColorSlots().forEach { add(it) } }
            put("displayMuted", muted)
            if (!isLateJoiner) {
                put("alive", aliveState[id] ?: true) // a mid-game reconnect keeps its KO state
                put("paused", paused)
            }
            // A controller (re)connecting during RESULTS needs the standings to show them.
            if (flow.state == RoomState.RESULTS) lastResultsJson?.let { put("results", it) }
        }
        transport.sendTo(id, welcome)
    }

    private fun enrichResults(results: List<PlayerResult>): List<ResultEntry> {
        val out = mutableListOf<ResultEntry>()
        val ranked = HashSet<Int>()
        for (r in results) {
            ranked.add(r.playerId)
            val rec = flow.player(r.playerId)
            out.add(
                ResultEntry(
                    playerId = r.playerId,
                    playerName = rec?.playerName,
                    colorIndex = rec?.colorSlot,
                    alive = r.alive,
                    lines = r.lines,
                    level = r.level,
                    rank = r.rank,
                ),
            )
        }
        for (rec in flow.list()) if (rec.peerIndex !in ranked) { // late joiners who sat out
            out.add(ResultEntry(playerId = rec.peerIndex, playerName = rec.playerName, colorIndex = rec.colorSlot, newPlayer = true))
        }
        return out
    }

    /** Serialize enriched results to the `game_end` wire array (omitting null fields, like Swift's dicts). */
    private fun resultsToJsonArray(list: List<ResultEntry>): JsonArray = buildJsonArray {
        for (e in list) {
            add(
                buildJsonObject {
                    put("playerId", e.playerId)
                    e.alive?.let { put("alive", it) }
                    e.lines?.let { put("lines", it) }
                    e.level?.let { put("level", it) }
                    e.rank?.let { put("rank", it) }
                    e.playerName?.let { put("playerName", it) }
                    e.colorIndex?.let { put("colorIndex", it) }
                    if (e.newPlayer) put("newPlayer", true)
                },
            )
        }
    }

    // =====================================================================
    // Helpers
    // =====================================================================

    // isExpired catches a controller that went silent within the last second, before the
    // 1 Hz liveness sweep could mark it disconnected (web prunes on isDisconnected || isExpired).
    private fun pruneDisconnected() {
        val now = nowWallMs()
        for (rec in flow.list()) if (flow.isDisconnected(rec.peerIndex) || flow.isExpired(rec.peerIndex, now)) {
            flow.removePlayer(rec.peerIndex)
            playerOrder.removeAll { it == rec.peerIndex }
        }
    }

    /**
     * Room-unique, language-neutral `HX-N` name honoring the web blocklist [4,13,17,69].
     * Deterministic lowest-free (mirrors tests/auto-name-helper.js; the web display picks
     * randomly from the same pool, but determinism is fine here and keeps it testable).
     * An explicit `preferred` HX-number is honored when free + allowed.
     */
    private fun autoName(preferred: String? = null, exceptId: Int? = null): String {
        val taken = HashSet<Int>()
        for (p in flow.list()) if (p.peerIndex != exceptId) autoNameNumber(p.playerName)?.let { taken.add(it) }
        autoNameNumber(preferred)?.let { n ->
            if (n !in AUTO_NAME_BLOCKLIST && n !in taken) return "HX-$n"
        }
        for (i in 1..99) if (i !in AUTO_NAME_BLOCKLIST && i !in taken) return "HX-$i"
        return "HX-1"
    }

    private fun autoNameNumber(name: String?): Int? =
        name?.let { AUTO_NAME_RE.matchEntire(it) }?.groupValues?.get(1)?.toIntOrNull()

    private fun sanitizeName(raw: String?): String? {
        if (raw == null) return null
        val sb = StringBuilder(raw.length)
        for (ch in raw) {
            if (ch.code < 0x20 || ch.code == 0x7F) continue // control chars + DEL (web strips [\x00-\x1f\x7f])
            if (isDefaultIgnorable(ch)) continue
            sb.append(ch)
        }
        val trimmed = sb.toString().trim()
        if (trimmed.isEmpty()) return null
        // Legacy P1-8 slot names get auto-named (return null so callers fall to autoName).
        if (LEGACY_SLOT_RE.matches(trimmed)) return null
        return if (trimmed.length > NAME_MAX_LEN) trimmed.take(NAME_MAX_LEN) else trimmed
    }

    /** Approximates Swift's isDefaultIgnorableCodePoint for the common zero-width set. */
    private fun isDefaultIgnorable(ch: Char): Boolean {
        val c = ch.code
        return c == 0x00AD || c == 0x034F || c == 0x061C ||
            c in 0x200B..0x200F || c in 0x202A..0x202E || c in 0x2060..0x206F ||
            c == 0xFEFF || c in 0xFFF0..0xFFFB
    }

    private fun joinUrl(room: String, instance: String?): String {
        val frag = instance?.takeIf { it.isNotEmpty() }?.let { "#$it" } ?: ""
        return "${RelayConfig.CONTROLLER_BASE_URL}/$room$frag"
    }

    /** Cross-device rejoin URL for a dropped participant (carries ?claim=<idx>). */
    private fun rejoinUrl(peerIndex: Int): String {
        val r = room ?: return ""
        val frag = instance?.takeIf { it.isNotEmpty() }?.let { "#$it" } ?: ""
        return "${RelayConfig.CONTROLLER_BASE_URL}/$r?claim=$peerIndex$frag"
    }

    private fun nowWallMs(): Double = clock?.invoke() ?: epoch.elapsedNow().toDouble(DurationUnit.MILLISECONDS)
}
