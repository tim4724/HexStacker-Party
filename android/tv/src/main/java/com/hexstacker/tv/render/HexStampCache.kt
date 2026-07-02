package com.hexstacker.tv.render

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RadialGradient
import android.graphics.Shader
import com.hexstacker.core.render.ColorMath
import com.hexstacker.core.render.Rgb
import com.hexstacker.core.render.Theme
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.roundToInt
import kotlin.math.sqrt

/** A pre-rendered hex cell, blitted at a cell center via [Stamp.blitLeft]/[Stamp.blitTop]. */
internal class Stamp(val bitmap: Bitmap, val w: Int, val h: Int) {
    fun blitLeft(cx: Float): Float = cx - w / 2f
    fun blitTop(cy: Float): Float = cy - h / 2f
}

/**
 * Port of `getHexStamp` + the three tier recipes (`_stampHexNormal/Pillow/NeonFlat`,
 * public/shared/CanvasUtils.js). Each `(tier, color, size)` is drawn ONCE to a
 * software [Bitmap] and blitted thereafter. `size` is the drawn cell HEIGHT
 * (`stampHeight` for stack/piece, `√3·drawS` for mini pieces).
 *
 * DPR is dropped (= 1): Android Canvas already works in device pixels, so the
 * bitmap dimensions ARE the draw dimensions. The only intentional pixel divergence
 * from the web is the pillow gloss (single-center [RadialGradient]; see below).
 *
 * Render-thread only: never touch a cached bitmap from the game thread.
 */
class HexStampCache(private val maxEntries: Int = 256) {

    private val sqrt3 = sqrt(3.0)

    // LRU cache (accessOrder); evicted entries are recycled.
    private val cache = object : LinkedHashMap<String, Stamp>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Stamp>): Boolean {
            val evict = size > maxEntries
            if (evict) eldest.value.bitmap.recycle()
            return evict
        }
    }

    // Reusable paints (stamps are built rarely, but keep allocation off the path).
    private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val strokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val bandPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }

    internal fun get(tier: Theme.StyleTier, color: Rgb, size: Double): Stamp {
        val key = "$tier|${color.r},${color.g},${color.b}|${(size * 10).roundToInt()}"
        cache[key]?.let { return it }

        val cr = size / sqrt3
        val pad = max(2, ceil(size * 0.04).toInt() + 1)
        val w = ceil(2 * cr).toInt() + pad * 2
        val h = ceil(size).toInt() + pad * 2
        val cx = (cr + pad).toFloat()
        val cy = h / 2f

        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        when (tier) {
            Theme.StyleTier.PILLOW -> stampPillow(c, cx, cy, cr.toFloat(), size.toFloat(), color)
            Theme.StyleTier.NEON_FLAT -> stampNeonFlat(c, cx, cy, cr.toFloat(), size.toFloat(), color)
            Theme.StyleTier.NORMAL -> stampNormal(c, cx, cy, cr.toFloat(), size.toFloat(), color)
        }

        val stamp = Stamp(bmp, w, h)
        cache[key] = stamp
        return stamp
    }

    /** Recycle every cached bitmap (call on render-thread teardown). */
    fun clear() {
        for (s in cache.values) s.bitmap.recycle()
        cache.clear()
    }

    // ── Tier recipes ─────────────────────────────────────────────────────────

    private fun stampNormal(c: Canvas, cx: Float, cy: Float, cr: Float, size: Float, color: Rgb) {
        val path = Path().apply { addHex(cx, cy, cr) }
        c.save()
        c.clipPath(path)

        // Vertical gradient: lighten(15) -> darken(10).
        fillPaint.shader = LinearGradient(
            cx, cy - cr, cx, cy + cr,
            colorInt(ColorMath.lighten(color, 15.0)),
            colorInt(ColorMath.darken(color, 10.0)),
            Shader.TileMode.CLAMP,
        )
        c.drawPath(path, fillPaint)
        fillPaint.shader = null

        // Top highlight band (white @ highlight).
        bandPaint.color = TvColors.white.argb(Theme.Opacity.highlight)
        c.drawRect(cx - cr * 0.5f, cy - cr * 0.88f, cx - cr * 0.5f + cr, cy - cr * 0.88f + size * 0.08f, bandPaint)
        // Bottom shadow band (black @ shadow).
        bandPaint.color = TvColors.black.argb(Theme.Opacity.shadow)
        c.drawRect(cx - cr * 0.5f, cy + cr * 0.76f, cx - cr * 0.5f + cr, cy + cr * 0.76f + size * 0.08f, bandPaint)
        // Inner shine (white @ subtle).
        val sh = size * 0.35f
        bandPaint.color = TvColors.white.argb(Theme.Opacity.subtle)
        c.drawRect(cx - cr * 0.35f, cy - cr * 0.5f, cx - cr * 0.35f + sh, cy - cr * 0.5f + sh * 0.36f, bandPaint)

        c.restore()
    }

    private fun stampPillow(c: Canvas, cx: Float, cy: Float, cr: Float, size: Float, color: Rgb) {
        val cornerR = cr * 0.15f
        val lineInset = cornerR / sqrt3.toFloat()
        val path = Path().apply { addRoundedHex(cx, cy, cr, cornerR) }

        fillPaint.color = colorInt(color)
        c.drawPath(path, fillPaint)

        c.save()
        c.clipPath(path)
        // GOTCHA: web gloss is a two-point radial (start (cx-cr*0.05, cy-cr*0.1) ->
        // end (cx,cy)). Android RadialGradient is single-center; approximate at the
        // web's START center. Offset is ~5-10% of cr — the only intentional divergence.
        fillPaint.shader = RadialGradient(
            cx - cr * 0.05f, cy - cr * 0.1f, cr * 1.1f,
            TvColors.white.argb(0.3), TvColors.white.argb(0.0),
            Shader.TileMode.CLAMP,
        )
        c.drawPath(path, fillPaint)
        fillPaint.shader = null
        c.restore()

        // Bottom shadow line across the two lower vertices (1 & 2), pulled inside.
        strokePaint.color = TvColors.black.argb(0.25)
        strokePaint.strokeWidth = max(0.5f, size * 0.04f)
        val v1 = HEX_UNIT_F[1]
        val v2 = HEX_UNIT_F[2]
        c.drawLine(
            cx + cr * v1[0] - lineInset, cy + cr * v1[1],
            cx + cr * v2[0] + lineInset, cy + cr * v2[1],
            strokePaint,
        )
    }

    private fun stampNeonFlat(c: Canvas, cx: Float, cy: Float, cr: Float, size: Float, color: Rgb) {
        val path = Path().apply { addHex(cx, cy, cr) }
        // Dark fill = 30% of color (truncated).
        fillPaint.color = colorInt(ColorMath.neonDark(color))
        c.drawPath(path, fillPaint)

        val bw = max(1f, size * 0.08f)
        strokePaint.color = colorInt(color)
        strokePaint.strokeWidth = bw
        c.drawPath(path, strokePaint)

        // Top inner highlight line (vertices 4 -> 5), drawn at 45% alpha.
        val insetScale = 1f - bw / cr
        bandPaint.color = colorInt(ColorMath.lighten(color, 20.0))
        bandPaint.alpha = a255(0.45)
        bandPaint.style = Paint.Style.STROKE
        bandPaint.strokeWidth = max(0.5f, size * 0.032f)
        val v4 = HEX_UNIT_F[4]
        val v5 = HEX_UNIT_F[5]
        c.drawLine(
            cx + cr * insetScale * v4[0], cy + cr * insetScale * v4[1],
            cx + cr * insetScale * v5[0], cy + cr * insetScale * v5[1],
            bandPaint,
        )
        // Reset the shared band paint (it leaked STROKE/alpha for NORMAL's rects).
        bandPaint.style = Paint.Style.FILL
        bandPaint.alpha = 255
    }
}
