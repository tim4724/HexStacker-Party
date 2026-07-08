package com.hexstacker.tv.screenshot

import com.github.takahirom.roborazzi.captureRoboImage
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * In-game screenshots at full 1080p: the live multi-board game surface
 * ([com.hexstacker.tv.render.BoardSurfaceView]) laid out for 2 / 3 / 4 / 8 players via
 * `LayoutEngine`, with the match timer, per-tier boards, garbage meters, a KO'd board,
 * and the per-board disconnect/rejoin QR.
 *
 * Every board comes from the canonical cross-platform [GalleryFixtures]: the SAME
 * `HexCore.GalleryFixtures.gameSnapshot(...)` states the web and Apple TV galleries
 * render, produced by running the built engine bundle in QuickJS (no hand-ported
 * grids). Seat names/colors come from `roster(count)`, start levels from the variant.
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

    private val app get() = RuntimeEnvironment.getApplication()

    private fun gameShot(name: String, variant: String) {
        val fx = GalleryFixtures.game(variant)
        val seats = BoardFixtureRenderer.seats(GalleryFixtures.roster(fx.variant.players), fx.variant.levels)
        BoardFixtureRenderer.render(app, seats, fx.snapshot).captureRoboImage("$OUT/$name.png")
    }

    @Test fun gameLv1() = gameShot("game_lv1", "lv1")   // NORMAL tier, 4 boards, 01:15
    @Test fun gameLv8() = gameShot("game_lv8", "lv8")   // PILLOW tier + garbage meters
    @Test fun gameLv12() = gameShot("game_lv12", "lv12") // NEON_FLAT tier
    @Test fun game2p() = gameShot("game_2p", "2p")       // levels 3/9, garbage on board 1, 01:23
    @Test fun game3p() = gameShot("game_3p", "3p")       // levels 1/8/12, odd count → left-anchored timer, 00:47
    @Test fun game4p() = gameShot("game_4p", "4p")       // levels 3/9/12/1, board 3 KO'd, garbage, 02:12
    @Test fun game8p() = gameShot("game_8p", "8p")       // 8 boards, all tiers, board 5 KO'd, garbage, 02:34

    /** Per-board rejoin overlay: slot 1 dropped over the lv1 boards, QR encoding the
     *  production `?claim=<peerIndex>` rejoin URL (BoardSurfaceView.setDisconnected path). */
    @Test
    fun disconnectedController() {
        val fx = GalleryFixtures.game("lv1")
        val seats = BoardFixtureRenderer.seats(GalleryFixtures.roster(fx.variant.players), fx.variant.levels)
        val rejoin = GalleryFixtures.claimUrl(GalleryFixtures.join.qrText, peerIndex = 1)
        BoardFixtureRenderer.render(app, seats, fx.snapshot, disconnects = mapOf(1 to rejoin))
            .captureRoboImage("$OUT/disconnected_controller.png")
    }

    private companion object {
        const val OUT = "build/outputs/roborazzi"
    }
}
