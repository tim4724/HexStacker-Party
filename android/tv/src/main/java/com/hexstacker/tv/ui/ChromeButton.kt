package com.hexstacker.tv.ui

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
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
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Focusable text button — the web `.btn-primary`/`.btn-secondary` + tvOS
 * `MenuButton`, built on `Modifier.clickable` (whose non-touch-mode focus target
 * gives D-pad navigation, skip-disabled, and DPAD_CENTER/ENTER activation from
 * the native focus engine).
 *
 * Visuals (mirror `MenuButton.setFocused` + CSS, A2):
 *  - primary enabled → vertical gradient `[tint, tint*0.82]` (CSS color-mix 82% black)
 *  - secondary → borderless `--bg-card-soft` (web `.btn-secondary`)
 *  - disabled → quiet `--bg-card`, no border (web `.btn-primary:disabled`)
 *  - text: disabled `--text-secondary`, primary `--btn-primary-text`, secondary `--text-primary`
 *  - 16px corner (var(--radius-btn)); borderless at rest — focus adds the white
 *    4dp ring + scale 1.06. Disabled has no scale but STAYS focusable (ring only),
 *    so the empty lobby seats initial focus on the disabled Start (the main action)
 *    instead of letting the focus engine grab the ⓘ (tvOS parity)
 *
 * The label is uppercased here (CSS `text-transform`, not data).
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
    val shape = RoundedCornerShape(Tokens.radiusBtn)

    val fillModifier = when {
        enabled && primary -> Modifier.background(Brush.verticalGradient(listOf(tint, scaledColor(tint, 0.82f))), shape)
        enabled -> Modifier.background(Tokens.bgCardSoft, shape) // .btn-secondary (borderless)
        else -> Modifier.background(Tokens.bgCard, shape) // .btn-primary:disabled
    }
    // Borderless at rest (A2); focus adds the white ring.
    val ringModifier = if (focused) Modifier.border(4.dp, Tokens.white, shape) else Modifier
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
            // clickable provides the focus target itself (focusable-in-non-touch-mode)
            // and stays enabled even for a disabled button, so the focus node survives
            // enable/disable (a disabled Start holds focus in the empty lobby, and
            // enabling it must not drop focus). The action is gated instead; semantics
            // carry the disabled state for accessibility.
            .semantics { if (!enabled) disabled() }
            .clickable { if (enabled) onClick() }
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
