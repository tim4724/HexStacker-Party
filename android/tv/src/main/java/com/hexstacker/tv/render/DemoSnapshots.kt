package com.hexstacker.tv.render

import com.hexstacker.core.model.Axial
import com.hexstacker.core.model.Cell
import com.hexstacker.core.model.Ghost
import com.hexstacker.core.model.Piece
import com.hexstacker.core.model.PlayerState

/**
 * Frozen [PlayerState]s for design-time previews and the debug gallery (mirrors the
 * Apple TV `HEXSHOT` frozen states and the cross-platform VisualParityFixture). Not
 * used at runtime — the coordinator feeds real engine snapshots.
 */
object DemoSnapshots {

    private fun fixtureGrid(): List<List<Int>> {
        val g = MutableList(15) { MutableList(9) { 0 } }
        // VisualParityFixture bottom row: typeIds 1..6, garbage(9), 1, 2.
        val bottom = intArrayOf(1, 2, 3, 4, 5, 6, 9, 1, 2)
        for (c in 0 until 9) g[14][c] = bottom[c]
        // A little stack for visual interest.
        g[13][0] = 1; g[13][1] = 2; g[13][7] = 1; g[13][8] = 5
        g[12][8] = 5
        return g
    }

    private fun piece(): Piece = Piece(
        type = "I3",
        typeId = 1,
        anchorCol = 4,
        anchorRow = 0,
        cells = listOf(Axial(-1, 0), Axial(0, 0), Axial(1, 0)),
        blocks = listOf(Cell(3, 0), Cell(4, 0), Cell(5, 0)),
    )

    private fun ghost(): Ghost = Ghost(
        typeId = 1,
        anchorCol = 4,
        anchorRow = 12,
        blocks = listOf(Cell(3, 12), Cell(4, 12), Cell(5, 12)),
    )

    fun game(level: Int, alive: Boolean = true): PlayerState = PlayerState(
        id = 0,
        grid = fixtureGrid(),
        currentPiece = if (alive) piece() else null,
        ghost = if (alive) ghost() else null,
        holdPiece = "o",
        nextPieces = listOf("V3", "T3", "d"),
        level = level,
        lines = 7,
        alive = alive,
        pendingGarbage = if (level >= 8) 3 else 0,
        clearingCells = null,
        gridVersion = 1,
    )

    fun lv1(): PlayerState = game(1)        // NORMAL tier
    fun lv8(): PlayerState = game(8)        // PILLOW tier
    fun lv12(): PlayerState = game(12)      // NEON_FLAT tier
    fun ko(): PlayerState = game(1, alive = false)
}
