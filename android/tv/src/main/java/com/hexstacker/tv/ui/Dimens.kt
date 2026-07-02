package com.hexstacker.tv.ui

import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.max
import kotlin.math.min

/**
 * CSS-`clamp()` helper bound to a viewport. Widths/heights are treated as
 * dp ~= css-px (close enough for TV layout; the integrator fine-tunes against
 * the gallery). vmin/vw/vh mirror the CSS units used across display.css
 * and theme.css. Build one per screen from `BoxWithConstraints`:
 *
 * ```
 * BoxWithConstraints { val vp = Vp(maxWidth.value, maxHeight.value); ... }
 * ```
 */
class Vp(val wDp: Float, val hDp: Float) {
    val vmin: Float = min(wDp, hDp)

    private fun clamp(lo: Float, pref: Float, hi: Float): Float =
        pref.coerceIn(min(lo, hi), max(lo, hi))

    fun vminDp(lo: Float, pct: Float, hi: Float): Dp = clamp(lo, pct / 100f * vmin, hi).dp
    fun vminSp(lo: Float, pct: Float, hi: Float): TextUnit = clamp(lo, pct / 100f * vmin, hi).sp
    fun vhDp(lo: Float, pct: Float, hi: Float): Dp = clamp(lo, pct / 100f * hDp, hi).dp
    fun vhSp(lo: Float, pct: Float, hi: Float): TextUnit = clamp(lo, pct / 100f * hDp, hi).sp
    fun vwDp(lo: Float, pct: Float, hi: Float): Dp = clamp(lo, pct / 100f * wDp, hi).dp
    fun vwSp(lo: Float, pct: Float, hi: Float): TextUnit = clamp(lo, pct / 100f * wDp, hi).sp
}
