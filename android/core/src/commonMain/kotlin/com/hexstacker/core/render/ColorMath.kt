package com.hexstacker.core.render

import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * lighten / darken / ghost / luminance / neonDark, ported from CanvasUtils.js.
 * Returns typed [Rgb] / [Ghost] (the JS returns CSS strings; the parity test
 * parses them to compare).
 *
 * Rounding parity: JS `Math.round` (half->+inf) == Kotlin `roundToInt()`; JS `|0`
 * (truncate->0) == Kotlin `.toInt()`; JS `toFixed(2)` == `round(x*100)/100`.
 */
object ColorMath {

    /** Scale each channel by (1 + percent/100), round, clamp HIGH to 255. */
    fun lighten(c: Rgb, percent: Double): Rgb {
        val f = 1 + percent / 100
        return Rgb(
            min(255, (c.r * f).roundToInt()),
            min(255, (c.g * f).roundToInt()),
            min(255, (c.b * f).roundToInt()),
        )
    }

    /** Scale each channel by (1 - percent/100), round, NO clamp. */
    fun darken(c: Rgb, percent: Double): Rgb {
        val f = 1 - percent / 100
        return Rgb(
            (c.r * f).roundToInt(),
            (c.g * f).roundToInt(),
            (c.b * f).roundToInt(),
        )
    }

    /** NEON_FLAT dark fill: 30% of color, truncated toward zero (JS `| 0`). */
    fun neonDark(c: Rgb): Rgb =
        Rgb((c.r * 0.3).toInt(), (c.g * 0.3).toInt(), (c.b * 0.3).toInt())

    /** Perceptual luminance in 0..1. */
    fun luminance01(c: Rgb): Double =
        (c.r * 0.299 + c.g * 0.587 + c.b * 0.114) / 255

    data class Ghost(val rgb: Rgb, val outlineAlpha: Double, val fillAlpha: Double)

    /** ghostColor: lighten 30% toward white, floor 80, ceil 255; alphas from luminance. */
    fun ghost(c: Rgb): Ghost {
        fun chan(x: Int): Int = min(255, max(80, (x + (255 - x) * 0.3).roundToInt()))
        val lum = luminance01(c)
        val a = toFixed2(0.3 + (1 - lum) * 0.15)
        val fillA = toFixed2(a * 0.5)
        return Ghost(Rgb(chan(c.r), chan(c.g), chan(c.b)), a, fillA)
    }

    /**
     * Faithful ECMAScript `Number.toFixed(2)` for non-negative x, matching V8
     * byte-for-byte. V8 rounds the EXACT binary value of x to 2 decimals (half-up).
     * `round(x*100)/100` is NOT equivalent: multiplying by 100 rounds a value like
     * 0.18499999999999999778 UP to exactly 18.5, flipping 0.18 -> 0.19. So we round
     * half-up on the double's exact dyadic value (x = sig * 2^e) with integer math,
     * which loses no precision.
     */
    private fun toFixed2(x: Double): Double {
        if (!x.isFinite()) return x
        if (x <= 0.0) return 0.0
        val bits = x.toRawBits()
        val rawExp = ((bits ushr 52) and 0x7FF).toInt()
        val sig = (bits and 0xFFFFFFFFFFFFFL) or 0x10000000000000L // implicit leading 1 (normal)
        val e = rawExp - 1075 // x = sig * 2^e
        val k = -e
        // Domain guard: ghost alphas are normal doubles in (0,1), so e<0 and k in a
        // safe range. Anything else (subnormal / >=1 / huge k) falls back.
        if (rawExp == 0 || e >= 0 || k > 62) return floor(x * 100.0 + 0.5) / 100.0
        // x*100 = sig*100 / 2^k (exact rational). round half-up = floor(x*100 + 1/2).
        val n = (sig * 100L + (1L shl (k - 1))) shr k
        return n / 100.0
    }
}
