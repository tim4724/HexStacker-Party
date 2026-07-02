package com.hexstacker.tv.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import com.hexstacker.tv.R

/**
 * HEX STACKER gradient wordmark + PARTY subtitle (web `.gradient-title`,
 * tvOS `TitleTexture`). Compose fills the text natively with the 8-stop party
 * palette sweep — no baked bitmap. The 135° direction is approximated by
 * measuring the laid-out text and running the linear gradient from its
 * top-left to bottom-right.
 *
 * [mainSize] is the "HEX STACKER" font size; the subtitle is 0.42em of it.
 */
@Composable
fun Wordmark(mainSize: TextUnit, modifier: Modifier = Modifier) {
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        var textSize by remember { mutableStateOf(IntSize.Zero) }
        val brush = remember(textSize) {
            Brush.linearGradient(
                colors = Tokens.wordmarkStops,
                start = Offset.Zero,
                end = Offset(
                    textSize.width.toFloat().coerceAtLeast(1f),
                    textSize.height.toFloat().coerceAtLeast(1f),
                ),
            )
        }
        androidx.compose.material3.Text(
            text = stringResource(R.string.wordmark_main),
            style = AppType.wordmarkMain.merge(
                TextStyle(
                    brush = brush,
                    fontSize = mainSize,
                    textAlign = TextAlign.Center,
                ),
            ),
            onTextLayout = { textSize = it.size },
        )
        // CSS `.gradient-title__sub { margin-top: 0.25em }` resolves against the SUB's own
        // font-size (0.42em of main), so the real web gap is 0.25 * 0.42 = 0.105 * mainSize
        // (verified against the live page's computed style: 3.696px at mainSize 35.2px).
        Spacer(Modifier.height((mainSize.value * 0.105f).dp))
        androidx.compose.material3.Text(
            text = stringResource(R.string.wordmark_sub),
            style = AppType.wordmarkSub.merge(
                TextStyle(
                    color = Tokens.partySubColor, // .gradient-title__sub color #fff3c2
                    fontSize = mainSize * 0.42f, // .gradient-title__sub font-size 0.42em
                    textAlign = TextAlign.Center,
                ),
            ),
        )
    }
}
