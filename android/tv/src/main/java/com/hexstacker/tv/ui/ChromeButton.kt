package com.hexstacker.tv.ui

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Focusable text button — the web `.btn-primary`/`.btn-secondary` + tvOS
 * `MenuButton`, built on `Modifier.focusable` so D-pad navigation, skip-disabled,
 * and DPAD_CENTER/ENTER activation all come from the native focus engine.
 *
 * Visuals (mirror `MenuButton.setFocused` + CSS):
 *  - primary enabled → vertical gradient `[tint, tint*0.82]` (CSS color-mix 82% black)
 *  - secondary / disabled → solid `--bg-card`
 *  - text: disabled `--text-secondary`, primary `--btn-primary-text`, secondary `--text-primary`
 *  - focus ring white 4dp + scale 1.06; secondary unfocused keeps a 1dp strong border;
 *    disabled keeps a faint 1dp border, is NOT focusable, no scale
 *
 * The label is uppercased here (CSS `text-transform`, not data). Disabled buttons
 * mirror the lobby Start's full-opacity disabled style (grey bg + muted text), not
 * the 0.5-opacity `.btn-primary:disabled`.
 */
@Composable
fun ChromeButton(
    text: String,
    primary: Boolean,
    tint: Color,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    focusRequester: FocusRequester? = null,
    fontSize: TextUnit = 18.sp,
    contentPadding: PaddingValues = PaddingValues(horizontal = 28.dp, vertical = 14.dp),
    minWidth: Dp = Dp.Unspecified,
) {
    var focused by remember { mutableStateOf(false) }
    val scale by animateFloatAsState(
        targetValue = if (focused && enabled) 1.06f else 1f,
        label = "chromeButtonScale",
    )
    val shape = RoundedCornerShape(Tokens.radiusMd)

    val fillModifier = if (enabled && primary) {
        Modifier.background(Brush.verticalGradient(listOf(tint, scaledColor(tint, 0.82f))), shape)
    } else {
        Modifier.background(Tokens.bgCard, shape)
    }
    val ringModifier = when {
        !enabled -> Modifier.border(1.dp, Tokens.border, shape)
        focused -> Modifier.border(4.dp, Tokens.white, shape)
        primary -> Modifier
        else -> Modifier.border(1.dp, Tokens.borderStrong, shape)
    }
    val textColor = when {
        !enabled -> Tokens.textSecondary
        primary -> Tokens.btnPrimaryText
        else -> Tokens.textPrimary
    }

    androidx.compose.foundation.layout.Box(
        modifier
            .graphicsLayer { scaleX = scale; scaleY = scale }
            .then(if (minWidth != Dp.Unspecified) Modifier.widthIn(min = minWidth) else Modifier)
            .clip(shape)
            .then(fillModifier)
            .then(ringModifier)
            .then(focusRequester?.let { Modifier.focusRequester(it) } ?: Modifier)
            .onFocusChanged { focused = it.isFocused }
            .focusable(enabled = enabled)
            .clickable(enabled = enabled) { onClick() }
            .padding(contentPadding),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = text.uppercase(),
            style = AppType.buttonLabel.copy(fontSize = fontSize, color = textColor),
            textAlign = TextAlign.Center,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/** sRGB component scale toward black — CSS `color-mix(in srgb, c <f*100>%, black)`. */
internal fun scaledColor(c: Color, f: Float): Color =
    Color(red = c.red * f, green = c.green * f, blue = c.blue * f, alpha = c.alpha)
