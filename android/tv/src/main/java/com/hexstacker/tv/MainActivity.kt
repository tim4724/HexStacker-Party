package com.hexstacker.tv

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent
import android.view.View
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.hexstacker.core.display.CountdownValue
import com.hexstacker.core.display.DisplayCoordinator
import com.hexstacker.core.display.DisplayOutput
import com.hexstacker.core.display.DisplayScreen
import com.hexstacker.core.display.ResultEntry
import com.hexstacker.core.engine.EngineBridge
import com.hexstacker.core.model.GameEvent
import com.hexstacker.core.model.GameSnapshot
import com.hexstacker.core.net.RelayClient
import com.hexstacker.core.net.RelayConfig
import com.hexstacker.core.net.RelayTransport
import com.hexstacker.core.room.PlayerRecord
import com.hexstacker.tv.audio.MusicPlayer
import com.hexstacker.tv.net.WebRtcFastlane
import com.hexstacker.tv.render.BoardSurfaceView
import com.hexstacker.tv.render.SeatMeta
import com.hexstacker.tv.ui.ConnectionOverlay
import com.hexstacker.tv.ui.CountdownOverlay
import com.hexstacker.tv.ui.LobbyData
import com.hexstacker.tv.ui.LobbyPlayer
import com.hexstacker.tv.ui.LobbyScreen
import com.hexstacker.tv.ui.PauseOverlay
import com.hexstacker.tv.ui.ResultCard
import com.hexstacker.tv.ui.ResultsScreen
import com.hexstacker.tv.ui.onRemoteKeys
import kotlinx.coroutines.android.awaitFrame
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import com.hexstacker.tv.ui.CountdownValue as UiCountdownValue

/**
 * Android TV entry point. Wires the headless [DisplayCoordinator] (which drives the
 * QuickJS engine + relay + room FSM) to the native renderer ([BoardSurfaceView]),
 * the Compose-for-TV chrome, and the Media3 [MusicPlayer], via a [TvDisplayOutput]
 * bridge. The coordinator runs on the main dispatcher (engine frame() still suspends
 * onto its own thread), so every output callback is main-thread-safe.
 */
class MainActivity : ComponentActivity() {

    private lateinit var board: BoardSurfaceView
    private lateinit var music: MusicPlayer
    private lateinit var relay: RelayClient
    private lateinit var fastlane: WebRtcFastlane
    private lateinit var coordinator: DisplayCoordinator
    private lateinit var ui: TvDisplayOutput

    private var engine: EngineBridge? = null
    private val bundleText: String by lazy { assets.open("partycore.js").bufferedReader().use { it.readText() } }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        board = BoardSurfaceView(this)
        // The board must NOT grab D-pad focus, or the Compose lobby/results buttons
        // never receive it and the remote appears dead.
        board.isFocusable = false
        board.isFocusableInTouchMode = false
        music = MusicPlayer(this)
        ui = TvDisplayOutput(board, music)

        val mainHandler = Handler(Looper.getMainLooper())
        relay = RelayClient(callbackPoster = { block -> mainHandler.post(block) })
        // Surface the display's own relay link state: drives the RECONNECTING / DISCONNECTED
        // overlay AND tells the coordinator to pause/resume the running game on link loss
        // (coordinator is assigned just below; the first callback can't fire before connect()).
        relay.onConnectionState = { state, reconnectAttempt ->
            ui.setConnectionState(state, reconnectAttempt)
            coordinator.onLinkStateChanged(state)
        }
        // Slot-0 eviction (relay close 4000): another display took over this room.
        // RelayClient already disables reconnect and emits CLOSED; flag it as the
        // terminal "replaced" state so the overlay drops the RECONNECT button (re-arming
        // reconnect would only be evicted again). Fires right after the CLOSED state above.
        relay.onReplaced = { ui.setReplaced() }

        // Low-latency P2P controller input over a WebRTC DataChannel; the relay stays the
        // fallback (a controller whose fastlane can't open just sends input over the socket).
        fastlane = WebRtcFastlane(this, listOf(RelayConfig.STUN_URL))

        coordinator = DisplayCoordinator(
            transport = relay,
            output = ui,
            engineFactory = { specs, seed ->
                val b = engine ?: EngineBridge.create(bundleText).also { engine = it }
                b.createGame(specs, seed)
                b
            },
            fastlane = fastlane,
            dispatcher = kotlinx.coroutines.Dispatchers.Main,
        )

        setContent {
            val model by ui.state.collectAsStateWithLifecycle()
            HexStackerApp(
                board = board,
                model = model,
                onStart = { coordinator.remoteStartMatch() },
                onPlayAgain = { coordinator.remoteStartMatch() },
                onNewGame = { coordinator.remoteReturnToLobby() },
                onContinue = { lifecycleScope.launch { coordinator.remoteTogglePause() } },
                // The coordinator's TOGGLE_MUTE drives output.setMuted (music + UI),
                // so the overlay switch just needs to trigger it.
                onToggleMusic = { lifecycleScope.launch { coordinator.remoteToggleMute() } },
                onPlayPause = { coordinator.remotePlayPause(); true },
                onMenu = {
                    if (model.screen == DisplayScreen.GAME) {
                        lifecycleScope.launch { coordinator.remoteTogglePause() }; true
                    } else {
                        false
                    }
                },
                onReconnect = { relay.reconnect() },
            )
        }

        coordinator.start()

        // Render clock: drive coordinator.tick() once per frame on the main thread. Scoped to
        // repeatOnLifecycle(STARTED) so it stops requesting frames (and ticking the QuickJS
        // engine) while the app is backgrounded, and restarts with a fresh delta on return —
        // mirroring the web freezing the game when the tab is hidden.
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                var last = 0L
                while (isActive) {
                    val now = awaitFrame()
                    val dt = if (last == 0L) 0.0 else (now - last) / 1_000_000.0
                    last = now
                    coordinator.tick(dt)
                }
            }
        }
    }

    /** Background: silence music (the tick loop already stops via repeatOnLifecycle). */
    override fun onStop() {
        super.onStop()
        music.pauseForBackground()
    }

    /** Foreground: restore music only if a match is actively running (not paused/muted). */
    override fun onStart() {
        super.onStart()
        val m = ui.state.value
        // countdown == null gates out the 3/2/1/GO window: the screen is already GAME then,
        // but startMusic() only fires at GO. Resuming here mid-countdown would start the loop
        // from 0, which GO's startMusic() then restarts (an audible double-start).
        if (m.screen == DisplayScreen.GAME && !m.paused && !m.muted && m.countdown == null) {
            music.resumeFromBackground()
        }
    }

    /**
     * Remote/keyboard handling at the Activity level so it works even when no
     * Compose element is focused (e.g. during GAME, where the only on-screen
     * elements are the board + overlays). Play/Pause is the context action
     * (start / pause / continue / play-again); Menu/Back pause during a game.
     * D-pad navigation + Select are left to Compose focus on the lobby/results.
     *
     * BACK is consumed only during GAME (toggle pause); otherwise it falls through to
     * super so it still exits from the lobby/results. Without this, BACK mid-match would
     * reach finish() and drop every controller (during GAME nothing in Compose is focused,
     * so the pause overlay's own Key.Back handler never gets a chance). While paused the
     * overlay IS focused and routes Key.Back to unpause before this handler is reached.
     */
    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        when (keyCode) {
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
            KeyEvent.KEYCODE_MEDIA_PLAY,
            KeyEvent.KEYCODE_MEDIA_PAUSE,
            KeyEvent.KEYCODE_BUTTON_START,
            -> {
                // repeatCount == 0: act on the first press only; a held key auto-repeats
                // KeyDown, which would otherwise toggle pause/start over and over.
                if (event.repeatCount == 0) coordinator.remotePlayPause()
                return true
            }
            KeyEvent.KEYCODE_MENU,
            KeyEvent.KEYCODE_BACK,
            -> {
                if (ui.state.value.screen == DisplayScreen.GAME) {
                    if (event.repeatCount == 0) lifecycleScope.launch { coordinator.remoteTogglePause() }
                    return true
                }
            }
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onDestroy() {
        super.onDestroy()
        coordinator.stop()
        relay.shutdown() // stop the RelayClient serial executor so its worker thread dies
        fastlane.dispose() // release peer connections + the WebRTC factory
        music.release()
        // close() suspends (takes the engine lock, frees on the engine thread), so block
        // briefly here: teardown must not race an in-flight frame() on the way out.
        runBlocking { engine?.close() }
    }
}

/** Immutable UI state the Compose tree renders from. */
data class UiModel(
    val screen: DisplayScreen = DisplayScreen.LOBBY,
    val lobby: LobbyData? = null,
    val countdown: UiCountdownValue? = null,
    val results: List<ResultCard> = emptyList(),
    val paused: Boolean = false,
    val muted: Boolean = false,
    val connection: RelayTransport.ConnectionState = RelayTransport.ConnectionState.IDLE,
    // Current retry number while RECONNECTING, for the "Attempt N of M" status (web parity).
    val reconnectAttempt: Int = 0,
    // Terminal slot-0 eviction: another display took over this room. Distinguishes a
    // "replaced" CLOSED (no reconnect affordance) from an ordinary give-up CLOSED.
    val replaced: Boolean = false,
)

/**
 * Bridges the coordinator's [DisplayOutput] side-effects to the native renderer,
 * audio, and Compose state. All methods run on the coordinator's (main) dispatcher.
 */
class TvDisplayOutput(
    private val board: BoardSurfaceView,
    private val music: MusicPlayer,
) : DisplayOutput {

    private val _state = MutableStateFlow(UiModel())
    val state: StateFlow<UiModel> get() = _state

    private var room: String = ""
    private var joinUrl: String = ""
    private var roster: List<PlayerRecord> = emptyList()
    private var hostSlot: Int? = null

    override fun showScreen(screen: DisplayScreen) {
        // Only render the board surface during GAME/RESULTS; hiding it in the lobby
        // stops its render thread (the surface is destroyed) and saves the GPU.
        board.visibility = if (screen == DisplayScreen.LOBBY) View.GONE else View.VISIBLE
        // Keep the TV awake for the whole match (COUNTDOWN+PLAYING = DisplayScreen.GAME); the
        // TV itself gets no input, so without this the screensaver can fire mid-game. Mirrors
        // the web wake lock (acquire on countdown, release on results/lobby).
        board.keepScreenOn = (screen == DisplayScreen.GAME)
        // Entering GAME (at COUNTDOWN): reset the boards to empty first, so the previous
        // match's frozen frame doesn't linger and no piece/ghost shows during the 3-2-1
        // (web nulls its render state during countdown; pieces appear only once PLAYING ticks).
        if (screen == DisplayScreen.GAME) { board.clear(); configureBoards() }
        if (screen == DisplayScreen.LOBBY) board.clear()
        _state.value = _state.value.copy(
            screen = screen,
            countdown = if (screen == DisplayScreen.LOBBY) null else _state.value.countdown,
        )
    }

    override fun roomReady(room: String, joinUrl: String) {
        this.room = room
        this.joinUrl = joinUrl
        _state.value = _state.value.copy(lobby = buildLobby())
    }

    override fun updateLobby(players: List<PlayerRecord>, hostPeerIndex: Int?) {
        roster = players
        hostSlot = hostPeerIndex?.let { players.firstOrNull { p -> p.peerIndex == it }?.colorSlot }
        _state.value = _state.value.copy(lobby = buildLobby())
    }

    override fun showCountdown(value: CountdownValue) {
        val ui = when (value) {
            is CountdownValue.Number -> UiCountdownValue.Number(value.n)
            CountdownValue.Go -> UiCountdownValue.Go
        }
        _state.value = _state.value.copy(countdown = ui)
    }

    override fun renderSnapshot(snapshot: GameSnapshot) {
        board.submitSnapshot(snapshot)
        // Real gameplay frames mean the 3/2/1/GO sequence is over, so dismiss the
        // overlay. (During COUNTDOWN the engine isn't ticked, so the only snapshot
        // pushed is the one static frame at countdown start, which precedes the
        // first showCountdown — clearing a null/stale countdown there is harmless.)
        if (_state.value.countdown != null) {
            _state.value = _state.value.copy(countdown = null)
        }
    }

    override fun showResults(results: List<ResultEntry>) {
        _state.value = _state.value.copy(
            results = results.map {
                ResultCard(
                    playerId = it.playerId,
                    rank = it.rank,
                    name = it.playerName ?: resources.getString(R.string.player),
                    colorIndex = it.colorIndex,
                    lines = it.lines,
                    level = it.level,
                    newPlayer = it.newPlayer,
                )
            },
            countdown = null,
        )
    }

    override fun playCountdownBeep(go: Boolean) {
        if (go) music.playGoTone() else music.playCountdownBeep()
    }

    override fun startMusic() = music.start()
    override fun stopMusic() = music.stop()
    override fun pauseMusic() = music.pause()
    override fun resumeMusic() = music.resume()

    override fun setMuted(muted: Boolean) {
        music.setMuted(muted)
        setMutedState(muted) // reflect in the pause-overlay switch
    }

    override fun handleGameEvent(event: GameEvent) {
        board.onGameEvent(event)
    }

    override fun setDisconnected(playerId: Int, joinUrl: String?) {
        board.setDisconnected(playerId, joinUrl)
    }

    override fun setPaused(paused: Boolean) {
        _state.value = _state.value.copy(paused = paused, muted = music.isMuted)
    }

    /** Reflect a mute toggle (from the pause-overlay switch) in the UI immediately. */
    fun setMutedState(muted: Boolean) {
        _state.value = _state.value.copy(muted = muted)
    }

    fun setConnectionState(state: RelayTransport.ConnectionState, reconnectAttempt: Int = 0) {
        // Any non-CLOSED transition (a fresh/re-established link) clears a stale terminal
        // "replaced" flag. onReplaced sets it right after this posts CLOSED, so a CLOSED
        // transition preserves whatever was there.
        _state.value = _state.value.copy(
            connection = state,
            reconnectAttempt = reconnectAttempt,
            replaced = if (state == RelayTransport.ConnectionState.CLOSED) _state.value.replaced else false,
        )
    }

    /** Terminal slot-0 eviction (relay close 4000): another display took over this room. */
    fun setReplaced() {
        _state.value = _state.value.copy(replaced = true)
    }

    private fun configureBoards() {
        val seats = roster.map { SeatMeta(it.peerIndex, it.playerName, it.colorSlot, it.startLevel) }
        val w = if (board.width > 0) board.width else resources.displayMetrics.widthPixels
        val h = if (board.height > 0) board.height else resources.displayMetrics.heightPixels
        board.setViewport(w, h, seats.size, seats)
    }

    private val resources get() = board.resources

    private fun buildLobby(): LobbyData {
        val host = joinUrl.substringAfter("://", "").substringBefore("/").ifEmpty {
            RelayConfig.CONTROLLER_BASE_URL.substringAfter("://")
        }
        return LobbyData(
            joinHost = "$host/",
            joinCode = room,
            joinUrl = joinUrl.ifEmpty { RelayConfig.CONTROLLER_BASE_URL },
            players = roster.map { LobbyPlayer(it.peerIndex, it.playerName, it.colorSlot, it.startLevel) },
            hostColorIndex = hostSlot,
        )
    }
}

@Composable
private fun HexStackerApp(
    board: BoardSurfaceView,
    model: UiModel,
    onStart: () -> Unit,
    onPlayAgain: () -> Unit,
    onNewGame: () -> Unit,
    onContinue: () -> Unit,
    onToggleMusic: () -> Unit,
    onPlayPause: () -> Boolean,
    onMenu: () -> Boolean,
    onReconnect: () -> Unit,
) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .onRemoteKeys(onPlayPause = onPlayPause, onMenu = onMenu),
    ) {
        // z0: the live board (visible during GAME + RESULTS, behind overlays).
        AndroidView(factory = { board }, modifier = Modifier.fillMaxSize())

        when (model.screen) {
            DisplayScreen.LOBBY -> model.lobby?.let { LobbyScreen(data = it, onStart = onStart) }
            DisplayScreen.RESULTS -> ResultsScreen(
                results = model.results,
                hostColorIndex = model.lobby?.hostColorIndex,
                onPlayAgain = onPlayAgain,
                onNewGame = onNewGame,
            )
            DisplayScreen.GAME -> Unit
        }

        // Additive overlays on top of any screen.
        model.countdown?.takeIf { model.screen == DisplayScreen.GAME }?.let { CountdownOverlay(value = it) }
        if (model.paused && model.screen == DisplayScreen.GAME) {
            PauseOverlay(
                hostColorIndex = model.lobby?.hostColorIndex,
                musicOn = !model.muted,
                onToggleMusic = onToggleMusic,
                onContinue = onContinue,
                onNewGame = onNewGame,
            )
        }

        // Topmost: the display's own relay-link overlay (covers everything when our
        // connection to the relay drops).
        when (model.connection) {
            RelayTransport.ConnectionState.RECONNECTING ->
                ConnectionOverlay(
                    disconnected = false,
                    onReconnect = onReconnect,
                    attempt = model.reconnectAttempt,
                    maxAttempts = RelayConfig.MAX_RECONNECT_ATTEMPTS,
                )
            RelayTransport.ConnectionState.CLOSED ->
                // A "replaced" eviction is terminal: show DISCONNECTED with no RECONNECT
                // button (re-arming reconnect would only be evicted again), mirroring the
                // web dropping the reconnect affordance in that state.
                if (model.replaced) ConnectionOverlay(disconnected = true, showReconnect = false)
                else ConnectionOverlay(disconnected = true, onReconnect = onReconnect)
            else -> Unit
        }
    }
}
