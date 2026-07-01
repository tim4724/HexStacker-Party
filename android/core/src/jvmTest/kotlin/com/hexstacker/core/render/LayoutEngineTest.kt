package com.hexstacker.core.render

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Multi-board tiling math (port of DisplayUI.calculateLayout). A wrong grid choice
 * puts the wrong number/size of boards on screen, so pin the grid selection, the
 * placement count/bounds, and the textHeight-override contract.
 */
class LayoutEngineTest {

    // Mirrors the Kotlin default textHeight (measured glyph box + nameGap), stable in tests.
    private val th: (Double) -> Double = { cs -> maxOf(18.0, cs * 0.7) + cs * 0.6 }
    private val W = 1920.0
    private val H = 1080.0

    @Test
    fun smallCountsAreSingleRow() {
        assertEquals(1 to 1, LayoutEngine.chooseGrid(1, W, H, th))
        assertEquals(2 to 1, LayoutEngine.chooseGrid(2, W, H, th))
        assertEquals(3 to 1, LayoutEngine.chooseGrid(3, W, H, th))
    }

    @Test
    fun largerCountsPickAValidTwoOptionGrid() {
        // Each of these picks whichever of the two candidates yields the larger cell.
        assertTrue(LayoutEngine.chooseGrid(4, W, H, th) in setOf(4 to 1, 2 to 2))
        assertTrue(LayoutEngine.chooseGrid(5, W, H, th) in setOf(5 to 1, 3 to 2))
        assertTrue(LayoutEngine.chooseGrid(6, W, H, th) in setOf(6 to 1, 3 to 2))
        assertTrue(LayoutEngine.chooseGrid(7, W, H, th) in setOf(7 to 1, 4 to 2))
        assertTrue(LayoutEngine.chooseGrid(8, W, H, th) in setOf(8 to 1, 4 to 2))
    }

    @Test
    fun layoutPlacesEveryPlayerInBounds() {
        for (n in 1..8) {
            val layout = LayoutEngine.layout(n, W, H, th)
            assertEquals(n, layout.placements.size, "one placement per player (n=$n)")
            assertTrue(layout.cellSize >= 1.0, "positive cell size (n=$n)")
            for (p in layout.placements) {
                assertTrue(p.originX >= 0.0 && p.originX <= W, "board x in viewport (n=$n)")
                assertTrue(p.originY >= 0.0 && p.originY <= H, "board y in viewport (n=$n)")
            }
        }
    }

    @Test
    fun biggerTextReservationShrinksCells() {
        // A larger textHeight override reserves more vertical space, so cells can't be bigger.
        val roomy = LayoutEngine.layout(2, W, H) { cs -> maxOf(18.0, cs * 0.7) + cs * 0.6 }
        val tall = LayoutEngine.layout(2, W, H) { cs -> maxOf(18.0, cs * 0.7) + cs * 3.0 }
        assertTrue(tall.cellSize <= roomy.cellSize, "reserving more name height never grows the board")
    }
}
