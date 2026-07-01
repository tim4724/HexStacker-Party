package com.hexstacker.tv.ui

import androidx.compose.foundation.Canvas
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
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.unit.IntSize
import com.hexstacker.core.render.ColorMath
import com.hexstacker.core.render.HexGeometry
import com.hexstacker.core.render.Rgb
import com.hexstacker.core.render.Theme
import kotlinx.coroutines.isActive
import kotlin.math.hypot
import kotlin.math.min
import kotlin.math.sqrt

private val SQRT3 = sqrt(3f)

/**
 * Falling-piece welcome background (port of `WelcomeBackground.js`). Translucent
 * hex piece silhouettes raining down behind the lobby content. Drives a
 * `withFrameNanos` loop only while [active] (mirror tvOS `if !lobbyLayer.isHidden`);
 * the loop cancels when [active] flips false or the composable leaves.
 */
@Composable
fun LobbyBackground(modifier: Modifier = Modifier, active: Boolean = true) {
    val field = remember { FallingPieceField() }
    // One reusable Path for every hex cell of every particle — avoids a per-cell
    // per-frame Path allocation (drawn and clipped after each rewind/rebuild).
    val scratchPath = remember { Path() }
    var size by remember { mutableStateOf(IntSize.Zero) }
    val tick = remember { mutableStateOf(0L) } // bumped each frame to invalidate the Canvas

    // Keyed on size + active: the loop cancels and restarts when either changes,
    // so flipping `active` false stops the animation (mirror tvOS lobby gating).
    LaunchedEffect(size, active) {
        if (size == IntSize.Zero || !active) return@LaunchedEffect
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

    Canvas(
        modifier
            .fillMaxSize()
            .onSizeChanged { size = it },
    ) {
        tick.value // read so the draw phase re-runs each frame
        drawLobbyGlow()
        for (p in field.pool) drawFallingPiece(p, scratchPath)
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

/** Draw one particle's hex cells with the NORMAL stamp recipe (web `getHexStamp` /
 *  `_stampHexNormal`): a vertical light->dark gradient hex plus top-highlight,
 *  bottom-shadow and inner-shine bands, all weighted by the particle opacity
 *  (web `globalAlpha`). */
private fun DrawScope.drawFallingPiece(p: FallingPiece, path: Path) {
    val size = p.blockSize
    val cr = size * 0.94f // circumradius == web `sCell` (getHexStamp cr = size/√3)
    val heightSize = SQRT3 * cr // web stamp `size` (drawn height) for band proportions
    val alpha = p.opacity.coerceIn(0f, 1f)
    val rgb = Rgb(
        (p.colorArgb shr 16) and 0xFF,
        (p.colorArgb shr 8) and 0xFF,
        p.colorArgb and 0xFF,
    )
    val topColor = Color(ColorMath.lighten(rgb, 15.0).toArgb())
    val bottomColor = Color(ColorMath.darken(rgb, 10.0).toArgb())
    val band = heightSize * 0.08f
    val shine = heightSize * 0.35f
    for (cell in p.cells) {
        val q = cell[0]
        val r = cell[1]
        val cx = p.x + size * 1.5f * q
        val cy = p.y + size * SQRT3 * (r + q / 2f)
        buildHexPath(path, cx, cy, cr)
        // Base: vertical light->dark gradient clipped to the hex silhouette.
        drawPath(
            path,
            brush = Brush.verticalGradient(
                colors = listOf(topColor, bottomColor),
                startY = cy - cr,
                endY = cy + cr,
            ),
            alpha = alpha,
        )
        clipPath(path) {
            // Top highlight — white @ THEME.opacity.highlight.
            drawRect(
                color = Color.White.copy(alpha = (Theme.Opacity.highlight.toFloat() * alpha).coerceIn(0f, 1f)),
                topLeft = Offset(cx - cr * 0.5f, cy - cr * 0.88f),
                size = Size(cr, band),
            )
            // Bottom shadow — black @ THEME.opacity.shadow.
            drawRect(
                color = Color.Black.copy(alpha = (Theme.Opacity.shadow.toFloat() * alpha).coerceIn(0f, 1f)),
                topLeft = Offset(cx - cr * 0.5f, cy + cr * 0.76f),
                size = Size(cr, band),
            )
            // Inner shine — white @ THEME.opacity.subtle.
            drawRect(
                color = Color.White.copy(alpha = (Theme.Opacity.subtle.toFloat() * alpha).coerceIn(0f, 1f)),
                topLeft = Offset(cx - cr * 0.35f, cy - cr * 0.5f),
                size = Size(shine, shine * 0.36f),
            )
        }
    }
}

/** Rewind [path] and rebuild a flat-top hexagon (circumradius [radius]) from the
 *  `:core` unit vertices, so the single scratch Path is reused for every cell. */
private fun buildHexPath(path: Path, cx: Float, cy: Float, radius: Float) {
    path.rewind()
    HexGeometry.unitVertices.forEachIndexed { i, v ->
        val x = cx + (radius * v.x).toFloat()
        val y = cy + (radius * v.y).toFloat()
        if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
    }
    path.close()
}
