package com.hexstacker.tv.ui

import android.graphics.Bitmap
import android.graphics.Paint
import android.graphics.RadialGradient
import android.graphics.Shader
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.unit.IntSize
import com.hexstacker.core.render.HexGeometry
import com.hexstacker.tv.render.addRoundedHex
import kotlinx.coroutines.isActive
import kotlin.math.ceil
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sqrt

private val SQRT3 = sqrt(3f)

/**
 * Falling-piece welcome background (port of `WelcomeBackground.js`). Translucent
 * hex piece silhouettes raining down behind the lobby content. Drives a
 * `withFrameNanos` loop only while [active] (mirror tvOS `if !lobbyLayer.isHidden`);
 * the loop cancels when [active] flips false or the composable leaves.
 *
 * Two layers: the accent glow is its own static Canvas (re-recorded only on size
 * change), so the per-frame invalidation covers just the piece stamps — not a
 * full-screen gradient fill. Cells are drawn from pre-rendered bitmap stamps
 * ([PieceStampCache], the web `getHexStamp` cache) with the piece opacity applied
 * at draw time (web `globalAlpha`), so the frame loop allocates nothing.
 *
 * When [fixedPieces] is non-null (screenshot fixtures), the live animation is
 * skipped entirely and exactly those pieces are painted, scaled from the
 * 1920x1080 reference space they are authored in to the canvas — so the gallery
 * lobby shows the SAME frozen ambient columns as the web/tvOS galleries. Production
 * callers pass nothing and get the live field.
 */
@Composable
fun LobbyBackground(
    modifier: Modifier = Modifier,
    active: Boolean = true,
    fixedPieces: List<FallingPiece>? = null,
) {
    val field = remember { FallingPieceField() }
    val stamps = remember { PieceStampCache() }
    var size by remember { mutableStateOf(IntSize.Zero) }
    val tick = remember { mutableStateOf(0L) } // bumped each frame to invalidate the Canvas

    // Keyed on size + active: the loop cancels and restarts when either changes,
    // so flipping `active` false stops the animation (mirror tvOS lobby gating).
    // A frozen fixture skips the loop outright — the shot must not race an animation.
    LaunchedEffect(size, active, fixedPieces != null) {
        if (fixedPieces != null || size == IntSize.Zero || !active) return@LaunchedEffect
        field.resize(size.width.toFloat(), size.height.toFloat())
        var last = 0L
        while (isActive) {
            val now = withFrameNanos { it }
            val dt = if (last == 0L) 0f else min((now - last) / 1e9f, 0.05f)
            last = now
            field.advance(dt)
            tick.value = now
        }
    }

    Box(modifier) {
        Canvas(Modifier.fillMaxSize()) { drawLobbyGlow() }
        Canvas(
            Modifier
                .fillMaxSize()
                .onSizeChanged { size = it },
        ) {
            tick.value // read so the draw phase re-runs each frame
            if (fixedPieces != null) drawFixedPieces(fixedPieces, stamps)
            else for (p in field.pool) drawFallingPiece(p, stamps)
        }
    }
}

/** Reference space the fixture pieces are authored in (matches the web/tvOS gallery). */
private const val REF_W = 1920f
private const val REF_H = 1080f

/** Paint the frozen fixture pieces, scaling positions + hex size from the 1920x1080
 *  reference space to the actual canvas (scale 1 at the 1080p gallery viewport). */
private fun DrawScope.drawFixedPieces(pieces: List<FallingPiece>, stamps: PieceStampCache) {
    val sx = size.width / REF_W
    val sy = size.height / REF_H
    for (p in pieces) {
        drawFallingPiece(
            FallingPiece(
                cells = p.cells,
                blockSize = p.blockSize * sx,
                speed = 0f,
                opacity = p.opacity,
                colorArgb = p.colorArgb,
                x = p.x * sx,
                y = p.y * sy,
            ),
            stamps,
        )
    }
}

/** Accent-red radial glow baked behind the falling pieces (web `display.js`:
 *  cx 0.5, cy 0.3, alpha 0.06, stop end 0.55), painted over the parent's
 *  bgPrimary fill. */
private fun DrawScope.drawLobbyGlow() {
    val cx = size.width * 0.5f
    val cy = size.height * 0.3f
    // Max distance from the (0.5w, 0.3h) center to the four corners.
    val maxCornerDistance = maxOf(
        maxOf(hypot(cx, cy), hypot(size.width - cx, cy)),
        maxOf(hypot(cx, size.height - cy), hypot(size.width - cx, size.height - cy)),
    )
    drawRect(
        brush = Brush.radialGradient(
            colors = listOf(Tokens.accentPrimary.copy(alpha = 0.06f), Color.Transparent),
            center = Offset(cx, cy),
            radius = 0.55f * maxCornerDistance,
        ),
    )
}

/** Draw one particle's hex cells by stamping the cached pillow bitmap at each cell,
 *  weighted by the particle opacity (web `globalAlpha` over a `getHexStamp` stamp). */
private fun DrawScope.drawFallingPiece(p: FallingPiece, stamps: PieceStampCache) {
    val size = p.blockSize
    val stamp = stamps.get(p.colorArgb, size)
    val halfW = stamp.width / 2f
    val halfH = stamp.height / 2f
    val alpha = p.opacity.coerceIn(0f, 1f)
    for (cell in p.cells) {
        val q = cell[0]
        val r = cell[1]
        val cx = p.x + size * 1.5f * q
        val cy = p.y + size * SQRT3 * (r + q / 2f)
        drawImage(stamp, topLeft = Offset(cx - halfW, cy - halfH), alpha = alpha)
    }
}

/**
 * Pre-rendered hex-cell stamps, keyed on (color, whole-px block size) — the port of
 * the web `getHexStamp` cache. Each stamp is the full-opacity PILLOW recipe (web
 * `_stampHexPillow`, matching the favicon/app-icon look): a flat-fill rounded hex
 * with a top-left radial gloss and a bottom-edge shadow line. Rendering a stamp
 * once and blitting it per cell replaces the previous per-cell-per-frame
 * `Brush.radialGradient` (a native shader allocation) — the 60fps loop now only
 * does bitmap draws. Bounded: block sizes span 12..32px and there are 6 piece
 * colors, so at most ~126 tiny bitmaps live here for the lobby's lifetime.
 */
private class PieceStampCache {
    private val cache = HashMap<Long, ImageBitmap>()

    fun get(colorArgb: Int, blockSize: Float): ImageBitmap {
        val px = blockSize.roundToInt().coerceAtLeast(1)
        val key = (colorArgb.toLong() shl 32) or px.toLong()
        return cache.getOrPut(key) { render(colorArgb, px) }
    }

    private fun render(colorArgb: Int, px: Int): ImageBitmap {
        val cr = px * 0.94f // circumradius == web `sCell` (getHexStamp cr = size/√3)
        val heightSize = SQRT3 * cr // web stamp `size` (drawn height) for line-width proportions
        val strokeW = max(0.5f, heightSize * 0.04f)
        // Pad past the hex bbox so the bottom shadow stroke + antialiasing aren't cropped.
        val pad = ceil(strokeW).toInt() + 1
        val w = ceil(2f * cr).toInt() + 2 * pad
        val h = ceil(heightSize).toInt() + 2 * pad
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val canvas = android.graphics.Canvas(bmp)
        val cx = w / 2f
        val cy = h / 2f
        val cornerR = cr * 0.15f
        val path = android.graphics.Path().apply { addRoundedHex(cx, cy, cr, cornerR) }
        val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        // Base: flat fill.
        paint.color = colorArgb
        canvas.drawPath(path, paint)
        // Radial gloss: white 0.3 -> transparent, center offset up-left. (Web uses a
        // two-point radial; Android is single-center, approximated at the web start.)
        paint.shader = RadialGradient(
            cx - cr * 0.05f, cy - cr * 0.1f, cr * 1.1f,
            0x4DFFFFFF, 0x00FFFFFF, Shader.TileMode.CLAMP,
        )
        canvas.drawPath(path, paint)
        paint.shader = null
        // Bottom shadow line across the two lower vertices, pulled inside the
        // rounded corners.
        val lineInset = cornerR / SQRT3
        val v1 = HexGeometry.unitVertices[1]
        val v2 = HexGeometry.unitVertices[2]
        paint.color = 0x40000000 // black at 0.25
        paint.strokeWidth = strokeW
        paint.style = Paint.Style.STROKE
        canvas.drawLine(
            cx + cr * v1.x.toFloat() - lineInset, cy + cr * v1.y.toFloat(),
            cx + cr * v2.x.toFloat() + lineInset, cy + cr * v2.y.toFloat(),
            paint,
        )
        return bmp.asImageBitmap()
    }
}
