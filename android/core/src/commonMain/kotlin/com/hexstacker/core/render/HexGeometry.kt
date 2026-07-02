package com.hexstacker.core.render

import com.hexstacker.core.model.EngineConstants
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Flat-top, column-staggered hex board geometry. Byte-identical port of
 * `computeHexGeometry` (server/constants.js) plus the renderer's derived per-cell
 * tokens (BoardRenderer.js). All math is canvas Y-DOWN, board-local (origin 0,0).
 * Android Canvas is already Y-down, so NO axis flip (unlike SpriteKit).
 */
class HexGeometry(
    val cellSize: Double,
    val cols: Int = EngineConstants.COLS,
    val visibleRows: Int = EngineConstants.VISIBLE_ROWS,
) {
    val hexSize: Double
    val hexH: Double
    val colW: Double
    val hexW: Double
    val boardWidth: Double
    val boardHeight: Double

    val sCell: Double
    val stampHeight: Double
    val gridLineWidth: Double
    val borderWidth: Double
    val wallOutset: Double

    init {
        val c = cols.toDouble()
        val v = visibleRows.toDouble()
        val sqrt3 = sqrt(3.0)

        hexSize = c * cellSize / (1.5 * c + 0.5)
        hexH = sqrt3 * hexSize
        colW = 1.5 * hexSize
        hexW = 2 * hexSize
        boardWidth = colW * (c - 1) + 2 * hexSize
        // Keep the exact JS expression shape (do NOT pre-simplify to hexH*(v+0.5)).
        boardHeight = hexH * (v - 1) + hexH + hexH * 0.5

        sCell = hexSize - cellSize * 0.03 * 2 / sqrt3
        stampHeight = sqrt3 * sCell
        gridLineWidth = stampHeight * 0.03
        borderWidth = cellSize * 0.04
        wallOutset = cellSize * 0.02
    }

    /**
     * Board-local pixel center of cell (col, row), canvas Y-down. ODD columns are
     * staggered DOWN by half a hex. Exact from `hc()` (constants.js) with bx=by=0.
     */
    fun hexCenter(col: Int, row: Int): DoublePair {
        val x = colW * col + hexSize
        val y = hexH * (row + 0.5 * (col and 1)) + hexH / 2
        return DoublePair(x, y)
    }

    companion object {
        /**
         * Flat-top unit-hex vertices (circumradius 1), canvas Y-down. Vertex i at
         * angle 60°·i; index 0 = right (1,0), index 3 = left (-1,0). Exact from
         * HEX_UNIT_VERTICES (CanvasUtils.js) and `hv()`'s `Math.PI/3 * i`.
         */
        val unitVertices: List<DoublePair> = (0 until 6).map { i ->
            val a = PI / 3.0 * i
            DoublePair(cos(a), sin(a))
        }
    }
}
