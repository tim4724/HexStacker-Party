package com.hexstacker.tv.screenshot

import android.graphics.Bitmap
import android.graphics.Canvas
import com.github.takahirom.roborazzi.captureRoboImage
import com.hexstacker.core.model.GameSnapshot
import com.hexstacker.tv.render.BoardSurfaceView
import com.hexstacker.tv.render.DemoSnapshots
import com.hexstacker.tv.render.SeatMeta
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * In-game screenshots at full 1080p: the live multi-board game surface
 * ([BoardSurfaceView]) laid out for 2 / 3 / 4 players via `LayoutEngine`, with the
 * match timer, per-tier boards, garbage meters, and a KO'd board.
 *
 * [BoardSurfaceView] is a real SurfaceView whose render thread draws to a hardware
 * canvas that a headless run can't provide, so we drive its exact per-vsync render
 * path ([BoardSurfaceView.renderFrameForTest]) onto an owned 1920x1080 Bitmap and
 * capture that. The boards come from [DemoSnapshots], a tv-local frozen fixture
 * (mirroring the Apple TV HEXSHOT demo states), re-seated to distinct player ids/colors.
 *
 * These are record-only smoke tests: they assert the full render path runs without
 * throwing and emit PNGs to `build/outputs/roborazzi/` for human review. They are NOT
 * automated golden gates (no goldens are committed and `:tv:verifyRoborazziDebug` is
 * not run), matching the repo rule that UI regressions are caught via the gallery, not
 * visual snapshots.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = "w1920dp-h1080dp-land-mdpi")
class GameScreenshotTest {

    /** name / player color slot / start level / alive — one board's presentation. */
    private data class Seat(val name: String, val slot: Int, val level: Int, val alive: Boolean = true)

    private fun shoot(name: String, elapsedMs: Double, seats: List<Seat>) {
        val view = BoardSurfaceView(RuntimeEnvironment.getApplication())
        val seatMetas = seats.mapIndexed { i, s ->
            SeatMeta(playerId = i, name = s.name, colorSlot = s.slot, startLevel = s.level)
        }
        // Board j is drawn from players[j] (positional), so keep the same order as seats.
        val players = seats.mapIndexed { i, s -> DemoSnapshots.game(s.level, s.alive).copy(id = i) }

        view.setViewport(WIDTH, HEIGHT, seats.size, seatMetas)
        view.submitSnapshot(GameSnapshot(players = players, elapsed = elapsedMs))

        val bitmap = Bitmap.createBitmap(WIDTH, HEIGHT, Bitmap.Config.ARGB_8888)
        view.renderFrameForTest(Canvas(bitmap))
        bitmap.captureRoboImage("$OUT/$name.png")
    }

    @Test
    fun game2p() = shoot(
        "game_2p",
        elapsedMs = 83_000.0, // 01:23
        seats = listOf(
            Seat("ALEX", slot = 0, level = 3),  // NORMAL tier
            Seat("SAM", slot = 4, level = 9),   // PILLOW tier + garbage meter
        ),
    )

    @Test
    fun game3p() = shoot(
        "game_3p",
        elapsedMs = 47_000.0, // 00:47 (odd count → left-anchored timer)
        seats = listOf(
            Seat("ALEX", slot = 0, level = 1),
            Seat("SAM", slot = 4, level = 8),
            Seat("KAI", slot = 6, level = 12), // NEON_FLAT tier
        ),
    )

    @Test
    fun game4p() = shoot(
        "game_4p",
        elapsedMs = 132_000.0, // 02:12
        seats = listOf(
            Seat("ALEX", slot = 0, level = 3),
            Seat("SAM", slot = 4, level = 9),
            Seat("KAI", slot = 6, level = 12),
            Seat("JORDAN", slot = 2, level = 1, alive = false), // KO'd board
        ),
    )

    private companion object {
        const val OUT = "build/outputs/roborazzi"
        const val WIDTH = 1920
        const val HEIGHT = 1080
    }
}
