package com.hexstacker.core.parity

import com.hexstacker.core.render.ColorMath
import com.hexstacker.core.render.HexCell
import com.hexstacker.core.render.HexGeometry
import com.hexstacker.core.render.Rgb
import com.hexstacker.core.render.Theme
import com.hexstacker.core.render.Zigzag
import com.hexstacker.core.render.outlineVertices
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.math.abs
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Cross-engine parity: runs the ACTUAL web render math (server/constants.js,
 * theme.js, CanvasUtils.js) in QuickJS and asserts the Kotlin ports are
 * byte-identical (geometry, cell centers, derived render tokens, palettes, tiers,
 * color math, zigzag, outline). The Kotlin equivalent of appletv ParityCheck/RenderMathJS.
 *
 * NOT cross-engine-verified here: the multi-board tiling in DisplayUI.calculateLayout
 * (ported to LayoutEngine). Its grid choice + boardX/boardY math is byte-parity-able in
 * principle, but calculateLayout is a monolithic DOM/global-reading function (reads ctx,
 * players, playerOrder, window.innerWidth; constructs BoardRenderer/UIRenderer; returns
 * nothing) with no pure seam and a font-dependent textHeight (ctx.measureText). Running
 * the REAL JS would require a new production seam in DisplayUI.js or a large DOM shim in
 * the RenderMathJs harness; reimplementing the math in the test would not be parity. So
 * LayoutEngine is covered by same-engine unit tests (LayoutEngineTest) only.
 */
class RenderMathParityTest {

    private val json = Json
    private val tol = 1e-6

    @Test
    fun kotlinRenderMathMatchesWebJs() = RenderMathJs().withContext { eval ->
        geometry(eval)
        derivedTokens(eval)
        cellCenters(eval)
        pieceColors(eval)
        playerColors(eval)
        styleTiers(eval)
        colorMath(eval)
        outline(eval)
        zigzagFixtures(eval)
    }

    private suspend fun geometry(eval: RenderMathJs.Eval) {
        for (cs in listOf(10.0, 14.0, 20.0, 33.0)) {
            val g = json.parseToJsonElement(eval.str("JSON.stringify(__geom($cs))")).jsonObject
            val k = HexGeometry(cs)
            approx(g.d("hexSize"), k.hexSize, "hexSize@$cs")
            approx(g.d("hexH"), k.hexH, "hexH@$cs")
            approx(g.d("colW"), k.colW, "colW@$cs")
            approx(g.d("boardWidth"), k.boardWidth, "boardWidth@$cs")
            approx(g.d("boardHeight"), k.boardHeight, "boardHeight@$cs")
        }
    }

    private suspend fun derivedTokens(eval: RenderMathJs.Eval) {
        // BoardRenderer.js derives these per-cell render tokens from computeHexGeometry
        // plus fixed THEME scalars: sCell/stampHeight/gridLineWidth at :36-38, the full
        // border stroke width `cellSize*THEME.stroke.border` at :186, and the wall outset
        // `borderHalf = cellSize*THEME.stroke.border/2` at :59.
        // RenderMathJs does not export THEME, so the three theme scalars are inlined here
        // exactly as in theme.js (size.blockGap 0.03, stroke.grid 0.03, stroke.border 0.04);
        // the geometry (hexSize) still flows through the REAL computeHexGeometry in QuickJS,
        // so a wrong Kotlin formula or a V8/QuickJS float divergence fails. (A change to the
        // theme.js scalars themselves is out of scope of this harness; see the class note.)
        // wallOutset is verified HERE (independently of outline(), which feeds the same
        // value into both engines and so cannot catch a wrong wallOutset on its own).
        for (cs in listOf(10.0, 14.0, 20.0, 33.0)) {
            val v = json.decodeFromString<List<Double>>(
                eval.str(
                    """
                    JSON.stringify((function(){
                      var g = __geom($cs);
                      var s3 = Math.sqrt(3);
                      var sCell = g.hexSize - $cs * 0.03 * 2 / s3;  // hexSize - cellSize*THEME.size.blockGap*2/sqrt3
                      var stampHeight = s3 * sCell;                 // sqrt3 * sCell
                      var gridLineWidth = stampHeight * 0.03;       // stampHeight * THEME.stroke.grid
                      var borderWidth = $cs * 0.04;                 // cellSize * THEME.stroke.border
                      var wallOutset = $cs * 0.04 / 2;              // cellSize * THEME.stroke.border / 2
                      return [sCell, stampHeight, gridLineWidth, borderWidth, wallOutset];
                    })())
                    """.trimIndent(),
                ),
            )
            val k = HexGeometry(cs)
            approx(v[0], k.sCell, "sCell@$cs")
            approx(v[1], k.stampHeight, "stampHeight@$cs")
            approx(v[2], k.gridLineWidth, "gridLineWidth@$cs")
            approx(v[3], k.borderWidth, "borderWidth@$cs")
            approx(v[4], k.wallOutset, "wallOutset@$cs")
        }
    }

    private suspend fun cellCenters(eval: RenderMathJs.Eval) {
        val cs = 20.0
        val k = HexGeometry(cs)
        for ((col, row) in listOf(0 to 0, 1 to 0, 4 to 7, 8 to 14, 3 to 11)) {
            val a = json.decodeFromString<List<Double>>(eval.str("JSON.stringify(__center($col,$row,$cs))"))
            val c = k.hexCenter(col, row)
            approx(a[0], c.x, "center.x($col,$row)")
            approx(a[1], c.y, "center.y($col,$row)")
        }
    }

    private suspend fun pieceColors(eval: RenderMathJs.Eval) {
        for (id in listOf(1, 2, 3, 4, 5, 6, 9)) {
            val hex = eval.str("__PIECE_COLORS[$id]")
            assertEquals(Rgb.fromHex(hex), Theme.pieceColors[id], "pieceColor[$id]")
        }
    }

    private suspend fun playerColors(eval: RenderMathJs.Eval) {
        val count = eval.str("'' + __PLAYER_COLORS.length").toInt()
        assertEquals(8, count, "player color count")
        for (i in 0 until 8) {
            val hex = eval.str("__PLAYER_COLORS[$i]")
            assertEquals(Rgb.fromHex(hex), Theme.playerColors[i], "playerColor[$i]")
        }
    }

    private suspend fun styleTiers(eval: RenderMathJs.Eval) {
        for (level in listOf(1, 5, 6, 10, 11, 15)) {
            val js = eval.str("'' + __getStyleTier($level)")
            assertEquals(js, Theme.styleTierToken(Theme.styleTier(level)), "styleTier($level)")
        }
    }

    private suspend fun colorMath(eval: RenderMathJs.Eval) {
        // lighten / darken over every piece color at a few percentages.
        for ((id, c) in Theme.pieceColors) {
            val hex = "#%02X%02X%02X".format(c.r, c.g, c.b)
            for (pct in listOf(10.0, 15.0, 30.0)) {
                assertEquals(parseRgb(eval.str("__lighten('$hex',$pct)")), ColorMath.lighten(c, pct), "lighten($id,$pct)")
                assertEquals(parseRgb(eval.str("__darken('$hex',$pct)")), ColorMath.darken(c, pct), "darken($id,$pct)")
            }
            // NEON_FLAT (Lv 11+) dark fill parity.
            assertEquals(parseRgb(eval.str("__neonDark('$hex')")), ColorMath.neonDark(c), "neonDark($id)")
            val gj = json.parseToJsonElement(eval.str("JSON.stringify(__ghost('$hex'))")).jsonObject
            val (orgb, oa) = parseRgba(gj["outline"]!!.jsonPrimitive.content)
            val (frgb, fa) = parseRgba(gj["fill"]!!.jsonPrimitive.content)
            val kg = ColorMath.ghost(c)
            assertEquals(orgb, kg.rgb, "ghost.rgb($id)")
            assertEquals(frgb, kg.rgb, "ghost.fill.rgb($id)")
            approx(oa, kg.outlineAlpha, "ghost.outlineAlpha($id)", 1e-9)
            approx(fa, kg.fillAlpha, "ghost.fillAlpha($id)", 1e-9)
        }
    }

    private suspend fun outline(eval: RenderMathJs.Eval) {
        val cs = 20.0
        val k = HexGeometry(cs)
        // Feeds the SAME outset into both engines to check vertex geometry given an outset;
        // the k.wallOutset VALUE itself is pinned against JS in derivedTokens().
        for (outset in listOf(0.0, k.wallOutset)) {
            val js = json.decodeFromString<List<List<Double>>>(eval.str("JSON.stringify(__outline($cs,$outset))"))
            val ko = k.outlineVertices(outset)
            assertEquals(js.size, ko.size, "outline vertex count (outset=$outset)")
            for (i in js.indices) {
                approx(js[i][0], ko[i].x, "outline[$i].x (outset=$outset)")
                approx(js[i][1], ko[i].y, "outline[$i].y (outset=$outset)")
            }
        }
    }

    private suspend fun zigzagFixtures(eval: RenderMathJs.Eval) {
        // A: full bottom row.
        val a = grid()
        for (c in 0 until 9) a[14][c] = (c % 6) + 1
        assertZig(eval, a, null, "A.clearable")
        assertNear(eval, a, "A.nearClear")

        // B: bottom row, gap at col 3.
        val b = grid()
        for (c in 0 until 9) b[14][c] = (c % 6) + 1
        b[14][3] = 0
        assertZig(eval, b, null, "B.clearable")
        assertNear(eval, b, "B.nearClear")

        // C: gB grid + ghost fills the col-3 gap.
        assertZig(eval, b, listOf(HexCell(3, 14)), "C.clearable")

        // D: up zigzag @14 + full row @12.
        val d = grid()
        for (c in 0 until 9) d[if (c and 1 == 1) 13 else 14][c] = (c % 6) + 1
        for (c in 0 until 9) d[12][c] = (c % 6) + 1
        assertZig(eval, d, null, "D.clearable")
        assertNear(eval, d, "D.nearClear")
    }

    // --- helpers -------------------------------------------------------------

    private fun grid(): Array<IntArray> = Array(15) { IntArray(9) }

    private fun gridJs(g: Array<IntArray>): String =
        g.joinToString(",", "[", "]") { row -> row.joinToString(",", "[", "]") }

    private suspend fun assertZig(eval: RenderMathJs.Eval, g: Array<IntArray>, ghost: List<HexCell>?, label: String) {
        val ghostJs = ghost?.joinToString(",", "[", "]") { "[${it.col},${it.row}]" } ?: "null"
        val jsCells = parseCells(eval.str("JSON.stringify(__clearable(${gridJs(g)}, 9, $ghostJs))"))
        val ghostSet = ghost?.toHashSet() ?: hashSetOf()
        val isFilled = { c: Int, r: Int -> g[r][c] > 0 || HexCell(c, r) in ghostSet }
        val ghostContributes: ((Int, Int) -> Boolean)? =
            if (ghost != null) { c, r -> g[r][c] == 0 && HexCell(c, r) in ghostSet } else null
        val k = Zigzag.clearable(9, 15, isFilled, ghostContributes)
        assertEquals(jsCells, k, label)
    }

    private suspend fun assertNear(eval: RenderMathJs.Eval, g: Array<IntArray>, label: String) {
        val jsCells = parseCells(eval.str("JSON.stringify(__nearClear(${gridJs(g)}, 9))"))
        val k = Zigzag.nearClear(9, 15, isFilled = { c, r -> g[r][c] > 0 })
        assertEquals(jsCells, k, label)
    }

    private fun parseCells(s: String): List<HexCell> =
        json.decodeFromString<List<List<Int>>>(s).map { HexCell(it[0], it[1]) }

    private fun parseRgb(s: String): Rgb {
        val n = Regex("""-?\d+""").findAll(s).map { it.value.toInt() }.toList()
        return Rgb(n[0], n[1], n[2])
    }

    private fun parseRgba(s: String): Pair<Rgb, Double> {
        val inner = s.substringAfter("(").substringBefore(")")
        val parts = inner.split(",").map { it.trim() }
        return Rgb(parts[0].toInt(), parts[1].toInt(), parts[2].toInt()) to parts[3].toDouble()
    }

    private fun JsonObject.d(key: String): Double = this[key]!!.jsonPrimitive.double

    private fun approx(a: Double, b: Double, label: String, t: Double = tol) {
        assertTrue(abs(a - b) < t, "$label: expected $a, got $b (|d|=${abs(a - b)})")
    }
}
