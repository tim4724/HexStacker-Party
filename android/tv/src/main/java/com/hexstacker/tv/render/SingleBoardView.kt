package com.hexstacker.tv.render

import android.content.Context
import android.graphics.Canvas
import android.os.SystemClock
import android.util.AttributeSet
import android.view.View
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.viewinterop.AndroidView
import com.hexstacker.core.model.EngineConstants
import com.hexstacker.core.model.PlayerState
import com.hexstacker.core.render.LayoutEngine
import com.hexstacker.core.render.Theme

/**
 * A plain `View` that renders ONE board from a frozen [PlayerState] onto its
 * software/hardware `onDraw` canvas. Useful for embedding a single board in
 * Compose (`AndroidView`), for the debug gallery, and for `@Preview`. The live
 * multi-board game surface is [BoardSurfaceView]; this is the static sibling.
 *
 * Set [snapshot] (and optionally [colorSlot] / [playerName]) then `invalidate()`.
 */
class SingleBoardView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : View(context, attrs) {

    private val fonts = Fonts(context)
    private val stampCache = HexStampCache()
    private var renderer: BoardRenderer? = null
    private var builtForKey = -1L

    var snapshot: PlayerState = emptyBoard()
        set(value) {
            field = value
            invalidate()
        }

    var colorSlot: Int = 0
        set(value) {
            field = value
            builtForKey = -1L
            invalidate()
        }

    var playerName: String = "Player 1"
        set(value) {
            field = value
            builtForKey = -1L
            invalidate()
        }

    init {
        setWillNotDraw(false)
    }

    override fun onDraw(canvas: Canvas) {
        canvas.drawColor(Theme.bgPrimary.toArgb())
        val w = width
        val h = height
        if (w <= 0 || h <= 0) return

        val key = (w.toLong() shl 32) or h.toLong()
        if (renderer == null || builtForKey != key) {
            renderer?.recycle()
            val layout = LayoutEngine.layout(1, w.toDouble(), h.toDouble())
            val pl = layout.placements.first()
            renderer = BoardRenderer(
                context = context,
                geometry = layout.geometry,
                boardX = pl.originX.toFloat(),
                boardY = pl.originY.toFloat(),
                colorSlot = colorSlot,
                name = playerName,
                stampCache = stampCache,
                fonts = fonts,
            )
            builtForKey = key
        }
        renderer!!.render(canvas, snapshot, SystemClock.uptimeMillis().toDouble())
    }

    override fun onDetachedFromWindow() {
        super.onDetachedFromWindow()
        renderer?.recycle()
        renderer = null
        stampCache.clear()
        builtForKey = -1L
    }

    private companion object {
        /** An empty board (no piece/stack) — the default before the coordinator feeds
         *  a real engine snapshot. Live gameplay comes from the engine, not fixtures. */
        fun emptyBoard(level: Int = 1): PlayerState = PlayerState(
            id = 0,
            grid = List(EngineConstants.VISIBLE_ROWS) { List(EngineConstants.COLS) { 0 } },
            level = level,
            lines = 0,
            alive = true,
            pendingGarbage = 0,
            gridVersion = 0,
        )
    }
}

@Preview(widthDp = 360, heightDp = 640)
@Composable
private fun SingleBoardPreviewNormal() {
    AndroidView(
        modifier = Modifier,
        factory = { ctx -> SingleBoardView(ctx).apply { colorSlot = 0 } },
    )
}

@Preview(widthDp = 360, heightDp = 640)
@Composable
private fun SingleBoardPreviewNeon() {
    AndroidView(
        modifier = Modifier,
        factory = { ctx -> SingleBoardView(ctx).apply { colorSlot = 4 } },
    )
}
