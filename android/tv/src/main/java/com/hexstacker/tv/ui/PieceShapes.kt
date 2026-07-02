package com.hexstacker.tv.ui

import com.hexstacker.core.model.EngineConstants
import com.hexstacker.core.render.Theme

/**
 * Falling-background piece silhouettes, derived from the canonical piece set
 * (`server/Piece.js` PIECES) and the single-source `:core` [Theme] colors.
 * Mirrors `WelcomeBackground._syncFromEngine` + `_generateHexRotations`:
 * each kind carries all unique 60°-CW rotations, its piece color, and the
 * luminance-derived opacity boost.
 *
 * `:core` does not expose a `PieceShapes`/`pieceColor` API, so the small base
 * cell table lives here (it is a fixed game constant, not render math).
 */
object PieceShapes {

    /** Base axial cells `[q, r]` per type — verbatim from `server/Piece.js` PIECES. */
    private val base: Map<String, List<IntArray>> = mapOf(
        "I3" to listOf(intArrayOf(-1, 0), intArrayOf(0, 0), intArrayOf(1, 0)),
        "V3" to listOf(intArrayOf(1, -1), intArrayOf(0, 0), intArrayOf(-1, 0)),
        "T3" to listOf(intArrayOf(1, 0), intArrayOf(0, 0), intArrayOf(0, 1)),
        "o" to listOf(intArrayOf(-1, 0), intArrayOf(0, 0), intArrayOf(0, -1), intArrayOf(1, -1)),
        "d" to listOf(intArrayOf(1, 0), intArrayOf(0, 0), intArrayOf(-1, 0), intArrayOf(-1, 1)),
        "b" to listOf(intArrayOf(-1, 1), intArrayOf(0, 0), intArrayOf(1, -1), intArrayOf(1, 0)),
    )

    /** A piece kind ready to spawn: unique rotations + color + opacity boost. */
    class Kind(
        val rotations: List<List<IntArray>>,
        val colorArgb: Int,
        val opacityBoost: Float,
    )

    val pieces: List<Kind> = EngineConstants.PIECE_TYPES.map { type ->
        val id = EngineConstants.PIECE_TYPE_TO_ID.getValue(type)
        val rgb = Theme.pieceColors.getValue(id)
        Kind(
            rotations = rotationsOf(base.getValue(type)),
            colorArgb = rgb.toArgb(),
            opacityBoost = opacityBoost(rgb.r, rgb.g, rgb.b),
        )
    }

    /** Unique rotations via repeated axial 60°-CW `(q,r) -> (-r, q+r)`, dedup on
     *  exact ordered cell coords (mirrors `_generateHexRotations`). */
    private fun rotationsOf(baseCells: List<IntArray>): List<List<IntArray>> {
        val out = mutableListOf(baseCells)
        val sigs = mutableSetOf(sig(baseCells))
        var cur = baseCells
        repeat(5) {
            cur = cur.map { intArrayOf(-it[1], it[0] + it[1]) }
            val s = sig(cur)
            if (sigs.add(s)) out.add(cur)
        }
        return out
    }

    private fun sig(cells: List<IntArray>): String =
        cells.joinToString(";") { "${it[0]},${it[1]}" }

    /** BT.601 luma boost so dark piece colors stay visible (`_opacityBoost`). */
    private fun opacityBoost(r: Int, g: Int, b: Int): Float {
        val lum = 0.299 * r + 0.587 * g + 0.114 * b
        return when {
            lum < 115 -> 0.12f
            lum < 135 -> 0.06f
            else -> 0f
        }
    }
}
