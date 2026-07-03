package com.hexstacker.tv.screenshot

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import com.hexstacker.core.model.GameSnapshot
import com.hexstacker.tv.render.BoardSurfaceView
import com.hexstacker.tv.render.SeatMeta

/**
 * Renders the live multi-board game surface ([BoardSurfaceView]) straight onto an
 * owned 1920x1080 [Bitmap] via its per-vsync test path ([BoardSurfaceView.renderFrameForTest]),
 * so a headless Robolectric run captures a genuine in-game frame (the real
 * SurfaceView render thread needs a hardware canvas the JVM can't provide).
 *
 * Reused by the standalone game shots ([GameScreenshotTest]) and as the board layer
 * composited behind the countdown / pause / disconnect overlays ([ComposeScreenshotTest]),
 * mirroring how `MainActivity` layers the board under the Compose chrome.
 */
object BoardFixtureRenderer {
    const val WIDTH = 1920
    const val HEIGHT = 1080

    /** SeatMeta from a canonical roster; [levels] (a variant's start levels) override the
     *  lobby levels for in-game seats, else the roster's own level is used. */
    fun seats(roster: List<RosterEntry>, levels: List<Int>? = null): List<SeatMeta> =
        roster.mapIndexed { i, r ->
            SeatMeta(playerId = r.id, name = r.name, colorSlot = r.slot, startLevel = levels?.getOrNull(i) ?: r.level)
        }

    /**
     * @param snapshot the live frame to draw, or null for the pre-game (empty) boards.
     * @param disconnects playerId -> rejoin URL, drives the per-board "SCAN TO REJOIN" QR.
     */
    fun render(
        context: Context,
        seats: List<SeatMeta>,
        snapshot: GameSnapshot? = null,
        disconnects: Map<Int, String> = emptyMap(),
    ): Bitmap {
        val view = BoardSurfaceView(context)
        view.setViewport(WIDTH, HEIGHT, seats.size, seats)
        snapshot?.let { view.submitSnapshot(it) }
        disconnects.forEach { (playerId, url) -> view.setDisconnected(playerId, url) }
        val bitmap = Bitmap.createBitmap(WIDTH, HEIGHT, Bitmap.Config.ARGB_8888)
        view.renderFrameForTest(Canvas(bitmap))
        return bitmap
    }
}
