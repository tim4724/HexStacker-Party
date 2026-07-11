package com.hexstacker.tv.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.keyframes
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.sp
import com.hexstacker.tv.R
import kotlin.math.min

/**
 * Countdown overlay (web `#countdown-overlay`, tvOS `showCountdown`): a flat plum
 * scrim (same backdrop as every other game overlay — A2 dropped the radial glow)
 * with the big accent-colored "3 / 2 / 1 / GO". Numbers pulse (countdownBeat
 * 1→1.06→1, 1s loop); each value pops in. Non-focusable — it never steals focus
 * from the screen beneath.
 *
 * Stateless: the host drives the value sequence and clears the overlay after the
 * GO exit (this composable renders appearance only).
 */
@Composable
fun CountdownOverlay(value: CountdownValue, modifier: Modifier = Modifier) {
    BoxWithConstraints(
        modifier
            .fillMaxSize()
            .background(Tokens.overlayBg), // web: var(--overlay-bg), flat
        contentAlignment = Alignment.Center,
    ) {
        val fontSize = min(maxHeight.value * 0.15f, 224f).sp // clamp(6rem,15vh,14rem)
        val isNumber = value is CountdownValue.Number
        val text = when (value) {
            is CountdownValue.Number -> value.n.toString() // literal display value (untranslated)
            CountdownValue.Go -> stringResource(R.string.go)
        }

        // Entry pop 0.7 -> 1.0, re-run per value.
        val entry = remember(value) { Animatable(0.7f) }
        LaunchedEffect(value) { entry.animateTo(1f, tween(180, easing = FastOutSlowInEasing)) }

        // Beat pulse on numbers only.
        val beat = if (isNumber) {
            val transition = rememberInfiniteTransition(label = "countdownBeat")
            transition.animateFloat(
                initialValue = 1f,
                targetValue = 1f,
                animationSpec = infiniteRepeatable(
                    animation = keyframes {
                        durationMillis = 1000
                        1f at 0
                        1.06f at 200
                        1f at 1000
                    },
                ),
                label = "countdownBeatScale",
            ).value
        } else {
            1f
        }

        Text(
            text = text,
            style = AppType.countdownNumber.copy(fontSize = fontSize, color = Tokens.accentPrimary),
            modifier = Modifier.graphicsLayer {
                val s = entry.value * beat
                scaleX = s
                scaleY = s
            },
        )
    }
}

/** Convenience overload: `n <= 0` renders GO, otherwise the number. */
@Composable
fun CountdownOverlay(n: Int, modifier: Modifier = Modifier) {
    CountdownOverlay(if (n <= 0) CountdownValue.Go else CountdownValue.Number(n), modifier)
}

@Preview(widthDp = 1280, heightDp = 720)
@Composable
private fun CountdownPreview() {
    CountdownOverlay(3)
}
