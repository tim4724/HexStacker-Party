package com.hexstacker.core.render

/**
 * 8-bit-per-channel RGB. Channels held as Int (0..255) for exact parity with the
 * web JS integer math; not pre-clamped (darken can underflow, lighten clamps to
 * 255 at the call site, identical to CanvasUtils.js).
 */
data class Rgb(val r: Int, val g: Int, val b: Int) {

    /**
     * Pack to opaque ARGB Int for android.graphics.Canvas / Paint.setColor.
     * The :tv Canvas layer consumes this; :core never imports android.graphics.Color.
     */
    fun toArgb(alpha: Int = 0xFF): Int =
        ((alpha and 0xFF) shl 24) or
            ((r and 0xFF) shl 16) or
            ((g and 0xFF) shl 8) or
            (b and 0xFF)

    companion object {
        /**
         * Parse "#rrggbb" or "rrggbb" (case-insensitive). Returns null if
         * malformed, matching CanvasUtils.hexToRgb's regex contract.
         */
        fun fromHex(hex: String): Rgb? {
            var s = hex
            if (s.startsWith("#")) s = s.substring(1)
            if (s.length != 6) return null
            val v = s.toLongOrNull(16) ?: return null
            return Rgb(
                ((v shr 16) and 0xFF).toInt(),
                ((v shr 8) and 0xFF).toInt(),
                (v and 0xFF).toInt(),
            )
        }
    }
}

/** A board cell as (col, row), canvas/grid space; matches the engine `[col,row]` order. */
data class HexCell(val col: Int, val row: Int)

/** Tiny tuple so :core stays android-graphics-free. */
data class DoublePair(val x: Double, val y: Double)
