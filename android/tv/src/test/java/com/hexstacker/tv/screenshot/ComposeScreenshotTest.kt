package com.hexstacker.tv.screenshot

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import com.github.takahirom.roborazzi.captureRoboImage
import com.hexstacker.tv.ui.ConnectionOverlay
import com.hexstacker.tv.ui.CountdownOverlay
import com.hexstacker.tv.ui.LobbyData
import com.hexstacker.tv.ui.LobbyPlayer
import com.hexstacker.tv.ui.LobbyScreen
import com.hexstacker.tv.ui.PauseOverlay
import com.hexstacker.tv.ui.QrRenderer
import com.hexstacker.tv.ui.ResultCard
import com.hexstacker.tv.ui.ResultsScreen
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Screenshot coverage for the Compose-for-TV chrome ([LobbyScreen], [ResultsScreen],
 * and the [CountdownOverlay] / [PauseOverlay] / [ConnectionOverlay] overlays).
 *
 * All content data comes from the canonical cross-platform [GalleryFixtures] (the
 * same `HexCore.GalleryFixtures` the web and Apple TV galleries use, run through
 * QuickJS), so every platform's screenshots render byte-identical rosters, join
 * data, and results. The countdown / pause / disconnect states composite the real
 * board layer ([BoardFixtureRenderer]) behind the Compose overlay, mirroring how
 * `MainActivity` layers `BoardSurfaceView` under the chrome.
 *
 * Runs headless on the JVM (no emulator) via Robolectric's NATIVE graphics mode +
 * Roborazzi. Rendered at the 1280x720 TV design viewport the previews use, but at
 * hdpi (density 1.5) so the PNGs come out at full 1080p (1920x1080) with the exact
 * same composition. These are record-only smoke tests: capturing a frame asserts the
 * composable renders without throwing, and the PNGs land in `build/outputs/roborazzi/`
 * for human review (regenerate with `./gradlew :tv:recordRoborazziDebug`). They are NOT
 * automated golden gates (no goldens are committed and `:tv:verifyRoborazziDebug` is
 * not run), matching the repo rule that UI regressions are caught via the gallery, not
 * visual snapshots.
 *
 * Determinism: entrance/idle animations are frozen by disabling the compose test
 * clock's auto-advance and stepping a fixed amount, so infinite pulses (countdown
 * beat, lobby background) and time-gated reveals (the 1.5s results-button gate)
 * capture at a stable frame instead of a wall-clock-dependent one.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = "w1280dp-h720dp-land-hdpi") // 1280x720dp @ 1.5 density = 1920x1080px
class ComposeScreenshotTest {

    @get:Rule
    val compose = createComposeRule()

    private val app get() = RuntimeEnvironment.getApplication()

    private fun shoot(name: String, settleMs: Long = 1_800L, content: @Composable () -> Unit) {
        compose.mainClock.autoAdvance = false
        compose.setContent(content)
        // Step past the entrance animations + the results 1.5s button gate to a fixed frame.
        compose.mainClock.advanceTimeBy(settleMs)
        compose.onRoot().captureRoboImage("$OUT/$name.png")
    }

    // ── Lobby ────────────────────────────────────────────────────────────────

    private fun lobbyShot(name: String, count: Int) {
        val join = GalleryFixtures.join
        val players = if (count == 0) emptyList() else GalleryFixtures.roster(count).map {
            LobbyPlayer(peerIndex = it.id, name = it.name, colorIndex = it.slot, level = it.level)
        }
        val ambient = GalleryFixtures.ambientPieces()
        shoot(name) {
            LobbyScreen(
                data = LobbyData(
                    joinHost = join.host,
                    joinCode = join.code,
                    joinUrl = join.qrText,
                    players = players,
                    hostColorIndex = if (players.isEmpty()) null else 0, // host is roster slot 0
                ),
                onStart = {},
                // Inject a deterministic QR so the shot never races the async generator.
                qrOverride = QrRenderer.render(join.qrText, 480), // crisp at 1080p
                // Freeze the ambient background to the shared fixture so the four lobby
                // shots (and the web/tvOS galleries) show identical falling pieces.
                backgroundPieces = ambient,
            )
        }
    }

    @Test fun lobby() = lobbyShot("lobby", 4)
    @Test fun lobby2p() = lobbyShot("lobby_2p", 2)
    @Test fun lobby8p() = lobbyShot("lobby_8p", 8)
    @Test fun lobbyWaiting() = lobbyShot("lobby_waiting", 0)

    // ── Results ──────────────────────────────────────────────────────────────

    private fun ResultsFixture.cards(): List<ResultCard> = entries.map {
        ResultCard(
            playerId = it.playerId,
            rank = it.rank,
            name = it.playerName,
            colorIndex = it.colorIndex,
            lines = it.lines,
            level = it.level,
        )
    }

    // Results/connection shots composite the board layer the same way production
    // does: MainActivity keeps BoardSurfaceView VISIBLE for every screen except
    // the lobby, and these overlays draw the translucent (0.88) overlayBg scrim,
    // so the frozen boards show through faintly — matching web/tvOS's
    // frosted-glass backdrop (minus their blur, which a SurfaceView can't get).
    @Test
    fun results() {
        val board = boardLayer("lv1")
        shoot("results") {
            OverlayOnBoard(board) {
                ResultsScreen(
                    results = GalleryFixtures.results(4).cards(),
                    hostColorIndex = 0,
                    onPlayAgain = {},
                    onNewGame = {},
                )
            }
        }
    }

    @Test
    fun resultsSolo() {
        val board = boardLayer("solo")
        shoot("results_solo") {
            OverlayOnBoard(board) {
                ResultsScreen(
                    results = GalleryFixtures.results(1).cards(),
                    hostColorIndex = 0,
                    onPlayAgain = {},
                    onNewGame = {},
                )
            }
        }
    }

    // ── Countdown / pause (Compose overlay over the real board layer) ─────────

    /** Pre-game (empty) boards for the countdown seats, or a live variant snapshot. */
    private fun boardLayer(variant: String?): Bitmap {
        if (variant == null) {
            val seats = BoardFixtureRenderer.seats(GalleryFixtures.roster(4)) // fresh boards, lobby levels
            return BoardFixtureRenderer.render(app, seats)
        }
        val fx = GalleryFixtures.game(variant)
        val seats = BoardFixtureRenderer.seats(GalleryFixtures.roster(fx.variant.players), fx.variant.levels)
        return BoardFixtureRenderer.render(app, seats, fx.snapshot)
    }

    @Composable
    private fun OverlayOnBoard(board: Bitmap, overlay: @Composable () -> Unit) {
        Box(Modifier.fillMaxSize()) {
            Image(
                bitmap = board.asImageBitmap(),
                contentDescription = null,
                modifier = Modifier.fillMaxSize(),
                contentScale = ContentScale.FillBounds,
            )
            overlay()
        }
    }

    @Test
    fun countdown() {
        val board = boardLayer(null) // 4 fresh/empty boards, roster(4) seat names
        shoot("countdown") { OverlayOnBoard(board) { CountdownOverlay(3) } }
    }

    @Test
    fun pause() {
        val board = boardLayer("lv1")
        shoot("pause") {
            OverlayOnBoard(board) {
                PauseOverlay(
                    hostColorIndex = 0,
                    musicOn = true,
                    onToggleMusic = {},
                    onContinue = {},
                    onNewGame = {},
                )
            }
        }
    }

    // Real focus events can't fire here (Robolectric's headless compose host never
    // gains window focus), so this seeds the switch's focused state through the
    // shot-only override — the same `focused` boolean the focus system drives, so
    // the styling is the genuine focused visual.
    @Test
    fun pauseMusic() {
        val board = boardLayer("lv1")
        shoot("pause_music") {
            OverlayOnBoard(board) {
                PauseOverlay(
                    hostColorIndex = 0,
                    musicOn = true,
                    onToggleMusic = {},
                    onContinue = {},
                    onNewGame = {},
                    musicFocusedForShot = true,
                )
            }
        }
    }

    // ── Connection overlays (display's own relay link) ────────────────────────

    @Test
    fun connectionReconnecting() {
        val board = boardLayer("lv1")
        shoot("connection_reconnecting") {
            // attempt/max mirror the web gallery ("Attempt 2 of 5").
            OverlayOnBoard(board) {
                ConnectionOverlay(disconnected = false, onReconnect = {}, attempt = 2, maxAttempts = 5)
            }
        }
    }

    @Test
    fun connectionDisconnected() {
        val board = boardLayer("lv1")
        shoot("connection_disconnected") {
            OverlayOnBoard(board) { ConnectionOverlay(disconnected = true, onReconnect = {}) }
        }
    }

    private companion object {
        // Roborazzi resolves relative paths from the module dir (the test working dir).
        const val OUT = "build/outputs/roborazzi"
    }
}
