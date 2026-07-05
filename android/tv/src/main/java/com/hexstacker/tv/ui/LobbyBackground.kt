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
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.asAndroidPath
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.unit.IntSize
import com.hexstacker.core.render.HexGeometry
import com.hexstacker.tv.render.addRoundedHex
import kotlinx.coroutines.isActive
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

private val SQRT3 = sqrt(3f)

/**
 * Falling-piece welcome background (port of `WelcomeBackground.js`). Translucent
 * hex piece silhouettes raining down behind the lobby content. Drives a
 * `withFrameNanos` loop only while [active] (mirror tvOS `if !lobbyLayer.isHidden`);
 * the loop cancels when [active] flips false or the composable leaves.
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
    // One reusable Path for every hex cell of every particle — avoids a per-cell
    // per-frame Path allocation (drawn and clipped after each rewind/rebuild).
    val scratchPath = remember { Path() }
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

    Canvas(
        modifier
            .fillMaxSize()
            .onSizeChanged { size = it },
    ) {
        tick.value // read so the draw phase re-runs each frame
        drawLobbyGlow()
        if (fixedPieces != null) drawFixedPieces(fixedPieces, scratchPath)
        else for (p in field.pool) drawFallingPiece(p, scratchPath)
    }
}

/** Reference space the fixture pieces are authored in (matches the web/tvOS gallery). */
private const val REF_W = 1920f
private const val REF_H = 1080f

/** Paint the frozen fixture pieces, scaling positions + hex size from the 1920x1080
 *  reference space to the actual canvas (scale 1 at the 1080p gallery viewport). */
private fun DrawScope.drawFixedPieces(pieces: List<FallingPiece>, path: Path) {
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
            path,
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

/** Draw one particle's hex cells with the PILLOW stamp recipe (web `getHexStamp` /
 *  `_stampHexPillow`, matching the favicon/app-icon look): a flat-fill rounded hex
 *  with a top-left radial gloss and a bottom-edge shadow line, all weighted by the
 *  particle opacity (web `globalAlpha`). */
private fun DrawScope.drawFallingPiece(p: FallingPiece, path: Path) {
    val size = p.blockSize
    val cr = size * 0.94f // circumradius == web `sCell` (getHexStamp cr = size/√3)
    val heightSize = SQRT3 * cr // web stamp `size` (drawn height) for line-width proportions
    val alpha = p.opacity.coerceIn(0f, 1f)
    val fillColor = Color(
        (p.colorArgb shr 16) and 0xFF,
        (p.colorArgb shr 8) and 0xFF,
        p.colorArgb and 0xFF,
    )
    val cornerR = cr * 0.15f
    val lineInset = cornerR / SQRT3 // pull the shadow line inside the rounded corner
    val v1 = HexGeometry.unitVertices[1] // two lower vertices carry the bottom edge
    val v2 = HexGeometry.unitVertices[2]
    for (cell in p.cells) {
        val q = cell[0]
        val r = cell[1]
        val cx = p.x + size * 1.5f * q
        val cy = p.y + size * SQRT3 * (r + q / 2f)
        // Reuse the scratch Path via its backing android.graphics.Path so the
        // rounded-hex builder allocates nothing per cell.
        path.rewind()
        path.asAndroidPath().addRoundedHex(cx, cy, cr, cornerR)
        // Base: flat fill.
        drawPath(path, color = fillColor, alpha = alpha)
        // Radial gloss: white 0.3 -> transparent, center offset up-left. (Web uses a
        // two-point radial; Compose is single-center, approximated at the web start.)
        drawPath(
            path,
            brush = Brush.radialGradient(
                colors = listOf(Color.White.copy(alpha = 0.30f), Color.Transparent),
                center = Offset(cx - cr * 0.05f, cy - cr * 0.1f),
                radius = cr * 1.1f,
            ),
            alpha = alpha,
        )
        // Bottom shadow line across the two lower vertices.
        drawLine(
            color = Color.Black.copy(alpha = 0.25f * alpha),
            start = Offset(cx + cr * v1.x.toFloat() - lineInset, cy + cr * v1.y.toFloat()),
            end = Offset(cx + cr * v2.x.toFloat() + lineInset, cy + cr * v2.y.toFloat()),
            strokeWidth = max(0.5f, heightSize * 0.04f),
        )
    }
}
