package com.hexstacker.tv.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asComposePath
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import com.hexstacker.tv.R
import com.hexstacker.tv.render.addRoundedHex
import kotlin.math.sqrt

/**
 * HEX STACKER brand lockup (web `.brand-lockup--row`, tvOS `TitleTexture`):
 * triad mark beside a single-color cream wordmark with the PARTY subtitle,
 * nudged left by 0.4em of [mainSize] so the lockup reads optically centered
 * (the mark carries less "title weight" than the wordmark).
 *
 * [mainSize] is the "HEX STACKER" font size; the subtitle is 0.42em of it,
 * the mark is 1.7em tall, the mark/text gap is 0.5em.
 */
@Composable
fun Wordmark(mainSize: TextUnit, modifier: Modifier = Modifier) {
    val density = LocalDensity.current
    val mainDp = with(density) { mainSize.toDp() }
    Row(
        modifier.offset(x = -mainDp * 0.4f),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(mainDp * 0.5f),
    ) {
        TriadMark(Modifier.size(mainDp * 1.7f))
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            androidx.compose.material3.Text(
                text = stringResource(R.string.wordmark_main),
                style = AppType.wordmarkMain.merge(
                    TextStyle(
                        color = Tokens.textPrimary,
                        fontSize = mainSize,
                        textAlign = TextAlign.Center,
                    ),
                ),
            )
            // Web `.brand-lockup__sub { margin-top: 0.1em }` resolves against the
            // SUB's own font-size (0.42em of main) → 0.042 * mainSize.
            Spacer(Modifier.height((mainSize.value * 0.042f).dp))
            androidx.compose.material3.Text(
                text = stringResource(R.string.wordmark_sub),
                style = AppType.wordmarkSub.merge(
                    TextStyle(
                        color = Tokens.partySubColor, // .brand-lockup__sub color #fff3c2
                        fontSize = mainSize * 0.42f, // .brand-lockup__sub font-size 0.42em
                        textAlign = TextAlign.Center,
                    ),
                ),
            )
        }
    }
}

/**
 * The canonical triad mark (shared/brand-mark.svg): teal top-left, red below
 * it, honey right-center — pillow-shaded flat-top cells with tangent-rounded
 * corners. Same 70x70 proportions as the SVG: cell circumradius = size/3.5.
 */
@Composable
private fun TriadMark(modifier: Modifier = Modifier) {
    // PARTY_PALETTE triad = spectrum slots 4 (teal), 0 (red), 2 (honey).
    val cells = listOf(
        Triple(0f, 0f, playerColor(4)), // teal, top-left
        Triple(0f, 1f, playerColor(0)), // red, below it
        Triple(1f, 0f, playerColor(2)), // honey, right-center
    )
    Canvas(modifier) {
        val r = size.minDimension / 3.5f
        val hexH = sqrt(3f) * r
        val ox = size.minDimension * (20f / 70f)
        val oy = size.minDimension * (17.4f / 70f)
        val drawR = r * 0.94f
        for ((q, row, color) in cells) {
            val cx = ox + 1.5f * r * q
            val cy = oy + hexH * (row + q / 2f)
            val path = android.graphics.Path().apply {
                addRoundedHex(cx, cy, drawR, drawR * 0.15f)
            }.asComposePath()
            drawPath(path, color)
            // Radial sheen — brand-mark.svg <radialGradient cx .38 cy .26 r .95>
            // in cell-bbox units (bbox is 2*drawR wide, sqrt(3)*drawR tall).
            drawPath(
                path,
                Brush.radialGradient(
                    colors = listOf(Color.White.copy(alpha = 0.30f), Color.Transparent),
                    center = Offset(
                        cx - drawR + 0.38f * 2f * drawR,
                        cy - sqrt(3f) / 2f * drawR + 0.26f * sqrt(3f) * drawR,
                    ),
                    radius = 0.95f * 2f * drawR,
                ),
            )
            // Bottom-edge line — matches the SVG's black 22% stroke.
            val yBottom = cy + sqrt(3f) / 2f * drawR
            drawLine(
                color = Color.Black.copy(alpha = 0.22f),
                start = Offset(cx - 0.42f * drawR, yBottom),
                end = Offset(cx + 0.42f * drawR, yBottom),
                strokeWidth = 0.08f * drawR,
            )
        }
    }
}
