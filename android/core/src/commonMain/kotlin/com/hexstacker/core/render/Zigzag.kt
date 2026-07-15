package com.hexstacker.core.render

/**
 * Zigzag clear detection (clearable + nearClear), ported from
 * `checkZigzag` / `findClearableZigzags` / `findNearClearZigzags`
 * (server/constants.js). Used for the on-board clear preview and near-clear pulse.
 *
 * Render calling convention: `totalRows = grid.size` is the VISIBLE-rows slice
 * (15), not TOTAL_ROWS (19), since the snapshot grid is already `grid.slice(BUFFER_ROWS)`.
 */
object Zigzag {

    /**
     * up==false ("down"): same row r across all cols. up==true: even cols at row
     * r, odd cols at row r-1. Returns the line's cells, or null if any is
     * off-board or empty.
     */
    private fun check(
        r: Int,
        up: Boolean,
        cols: Int,
        totalRows: Int,
        isFilled: (Int, Int) -> Boolean,
    ): List<HexCell>? {
        for (col in 0 until cols) {
            val row = if (up && (col and 1) == 1) r - 1 else r
            if (row < 0 || row >= totalRows) return null
            if (!isFilled(col, row)) return null
        }
        return (0 until cols).map { c ->
            val rr = if (up && (c and 1) == 1) r - 1 else r
            HexCell(c, rr)
        }
    }

    /**
     * Bottom-first, greedy non-overlapping selection. When [ghostContributes] !=
     * null, a zigzag is kept only if >=1 of its cells is a ghost cell (clear
     * preview); pass null to skip (engine). Returns clearCells in selection order.
     */
    fun clearable(
        cols: Int,
        totalRows: Int,
        isFilled: (Int, Int) -> Boolean,
        ghostContributes: ((Int, Int) -> Boolean)? = null,
        minRow: Int = 0,
    ): List<HexCell> {
        val all = ArrayList<List<HexCell>>()
        for (r in minRow until totalRows) {
            check(r, up = false, cols, totalRows, isFilled)?.let { down ->
                if (ghostContributes == null || down.any { ghostContributes(it.col, it.row) }) {
                    all.add(down)
                }
            }
            if (r >= 1) {
                check(r, up = true, cols, totalRows, isFilled)?.let { up ->
                    if (ghostContributes == null || up.any { ghostContributes(it.col, it.row) }) {
                        all.add(up)
                    }
                }
            }
        }

        // Bottom-first sort: higher maxRow first; tie-break higher minRow.
        all.sortWith(Comparator { a, b ->
            val aMax = a.maxOf { it.row }
            val bMax = b.maxOf { it.row }
            if (aMax != bMax) return@Comparator bMax - aMax
            val aMin = a.minOf { it.row }
            val bMin = b.minOf { it.row }
            bMin - aMin
        })

        // Greedy non-overlap. stride = totalRows + 2 keeps row -1 (up-zigzags) collision-free.
        val stride = totalRows + 2
        fun key(c: HexCell) = c.col * stride + (c.row + 1)
        val used = HashSet<Int>()
        val out = ArrayList<HexCell>()
        for (zag in all) {
            if (zag.any { used.contains(key(it)) }) continue
            for (c in zag) {
                used.add(key(c)); out.add(c)
            }
        }
        return out
    }

    /**
     * Empty cells where filling that single cell completes a zigzag (down or up).
     * A cell that is the sole gap of >1 zigzag appears once. Scan order: row
     * ascending, down before up.
     */
    fun nearClear(
        cols: Int,
        totalRows: Int,
        isFilled: (Int, Int) -> Boolean,
        minRow: Int = 0,
    ): List<HexCell> {
        val stride = totalRows + 2
        val seen = HashSet<Int>()
        val out = ArrayList<HexCell>()

        fun scan(r: Int, up: Boolean) {
            var gap: HexCell? = null
            for (col in 0 until cols) {
                val row = if (up && (col and 1) == 1) r - 1 else r
                if (row < 0 || row >= totalRows) return
                if (!isFilled(col, row)) {
                    if (gap != null) return // 2+ empties: not a single-cell completer
                    gap = HexCell(col, row)
                }
            }
            val g = gap ?: return // already complete
            val k = g.col * stride + (g.row + 1)
            if (seen.add(k)) out.add(g)
        }

        for (r in minRow until totalRows) {
            scan(r, up = false)
            if (r >= 1) scan(r, up = true)
        }
        return out
    }
}

