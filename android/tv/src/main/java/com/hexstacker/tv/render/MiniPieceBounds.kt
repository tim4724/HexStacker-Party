package com.hexstacker.tv.render

/**
 * Precomputed bounding boxes for the flat-top hex mini pieces drawn in the
 * HOLD / NEXT panels. Port of the IIFE in `public/display/UIRenderer.js`
 * (`HEX_MINI_BOUNDS`).
 *
 * `visMidUnits` is the piece's true vertical midpoint in `hexH` units, accounting
 * for the per-cell half-hex stagger so staggered pieces (d / b) sit centered in
 * their slot — use this, NOT a bounding-box midpoint (BoardNode.swift's simpler
 * version mis-centers them).
 */
internal data class MiniOffset(val col: Int, val row: Int)

internal data class MiniBounds(
    val minC: Int,
    val maxC: Int,
    val minR: Int,
    val maxR: Int,
    val offsets: List<MiniOffset>,
    val visMidUnits: Double,
)

internal object MiniPieceBounds {

    /** Piece spawn shapes as axial (q, r) offsets — server/Piece.js `PIECES`. */
    private val PIECES: Map<String, List<Pair<Int, Int>>> = mapOf(
        "I3" to listOf(-1 to 0, 0 to 0, 1 to 0),
        "V3" to listOf(1 to -1, 0 to 0, -1 to 0),
        "T3" to listOf(1 to 0, 0 to 0, 0 to 1),
        "o" to listOf(-1 to 0, 0 to 0, 0 to -1, 1 to -1),
        "d" to listOf(1 to 0, 0 to 0, -1 to 0, -1 to 1),
        "b" to listOf(-1 to 1, 0 to 0, 1 to -1, 1 to 0),
    )

    /** axialToOffset(q,r) — odd-q offset conversion (server/Piece.js). */
    private fun axialToOffset(q: Int, r: Int): MiniOffset =
        MiniOffset(col = q, row = r + ((q - (q and 1)) shr 1))

    val table: Map<String, MiniBounds> = PIECES.mapValues { (_, cells) ->
        val offsets = cells.map { axialToOffset(it.first, it.second) }
        val minC0 = offsets.minOf { it.col }
        val minR0 = offsets.minOf { it.row }
        // Normalize: shift so minC starts at 0, preserving column parity.
        val shiftC = minC0 - (minC0 and 1) // round down to even
        val shiftR = minR0
        val shifted = offsets.map { MiniOffset(it.col - shiftC, it.row - shiftR) }

        val sMinC = shifted.minOf { it.col }
        val sMaxC = shifted.maxOf { it.col }
        val sMinR = shifted.minOf { it.row }
        val sMaxR = shifted.maxOf { it.row }

        var vMin = Double.POSITIVE_INFINITY
        var vMax = Double.NEGATIVE_INFINITY
        for (o in shifted) {
            val yu = o.row + 0.5 * (o.col and 1)
            if (yu < vMin) vMin = yu
            if (yu > vMax) vMax = yu
        }

        MiniBounds(
            minC = sMinC, maxC = sMaxC, minR = sMinR, maxR = sMaxR,
            offsets = shifted,
            visMidUnits = (vMin + vMax + 1) / 2,
        )
    }
}
