package com.hexstacker.tv.screenshot

import androidx.compose.runtime.Composable
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
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Screenshot coverage for the Compose-for-TV chrome ([LobbyScreen], [ResultsScreen],
 * and the [CountdownOverlay] / [PauseOverlay] / [ConnectionOverlay] overlays).
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

    private fun shoot(name: String, settleMs: Long = 1_800L, content: @Composable () -> Unit) {
        compose.mainClock.autoAdvance = false
        compose.setContent(content)
        // Step past the entrance animations + the results 1.5s button gate to a fixed frame.
        compose.mainClock.advanceTimeBy(settleMs)
        compose.onRoot().captureRoboImage("$OUT/$name.png")
    }

    @Test
    fun lobby() = shoot("lobby") {
        val url = "https://play.hexstacker.com/WXYZ"
        LobbyScreen(
            data = LobbyData(
                joinHost = "play.hexstacker.com/",
                joinCode = "WXYZ",
                joinUrl = url,
                players = listOf(
                    LobbyPlayer(peerIndex = 0, name = "ALEX", colorIndex = 0, level = 3),
                    LobbyPlayer(peerIndex = 1, name = "SAM", colorIndex = 4, level = 1),
                    LobbyPlayer(peerIndex = 2, name = "JORDAN", colorIndex = 6, level = 5),
                ),
                hostColorIndex = 0,
            ),
            onStart = {},
            // Inject a deterministic QR so the shot never races the async generator.
            qrOverride = QrRenderer.render(url, 480), // crisp at 1080p
        )
    }

    @Test
    fun lobbyEmpty() = shoot("lobby_waiting") {
        val url = "https://play.hexstacker.com/WXYZ"
        LobbyScreen(
            data = LobbyData(
                joinHost = "play.hexstacker.com/",
                joinCode = "WXYZ",
                joinUrl = url,
                players = emptyList(),
                hostColorIndex = null,
            ),
            onStart = {},
            qrOverride = QrRenderer.render(url, 480), // crisp at 1080p
        )
    }

    @Test
    fun results() = shoot("results") {
        ResultsScreen(
            results = listOf(
                ResultCard(playerId = 0, rank = 1, name = "ALEX", colorIndex = 0, lines = 12, level = 4),
                ResultCard(playerId = 1, rank = 2, name = "SAM", colorIndex = 4, lines = 8, level = 3),
                ResultCard(playerId = 2, rank = 3, name = "KAI", colorIndex = 2, lines = 5, level = 2),
                ResultCard(playerId = 3, rank = null, name = "JORDAN", colorIndex = 6, lines = null, level = null, newPlayer = true),
            ),
            hostColorIndex = 0,
            onPlayAgain = {},
            onNewGame = {},
        )
    }

    @Test
    fun countdown() = shoot("countdown") {
        CountdownOverlay(3)
    }

    @Test
    fun pause() = shoot("pause") {
        PauseOverlay(
            hostColorIndex = 4,
            musicOn = true,
            onToggleMusic = {},
            onContinue = {},
            onNewGame = {},
        )
    }

    @Test
    fun connectionReconnecting() = shoot("connection_reconnecting") {
        ConnectionOverlay(disconnected = false, onReconnect = {})
    }

    @Test
    fun connectionDisconnected() = shoot("connection_disconnected") {
        ConnectionOverlay(disconnected = true, onReconnect = {})
    }

    private companion object {
        // Roborazzi resolves relative paths from the module dir (the test working dir).
        const val OUT = "build/outputs/roborazzi"
    }
}
