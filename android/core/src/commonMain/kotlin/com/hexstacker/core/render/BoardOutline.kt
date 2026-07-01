package com.hexstacker.core.render

import kotlin.math.abs
import kotlin.math.sqrt

/**
 * Outline vertices for the board perimeter, canvas Y-down, origin (0,0). Exact
 * port of `computeHexOutlineVerts` (server/constants.js). `outset == 0` returns
 * the raw ring (well clip path); `outset != 0` returns the outward-offset ring
 * (wall stroke). JS `if (outset)` is a truthy check, so 0.0 is a no-op.
 */
fun HexGeometry.outlineVertices(outset: Double = 0.0): List<DoublePair> {
    val hs = hexSize
    val lastRow = visibleRows - 1
    val lastCol = cols - 1

    fun hc(col: Int, row: Int): DoublePair = hexCenter(col, row)
    fun hv(cx: Double, cy: Double, i: Int): DoublePair {
        val u = HexGeometry.unitVertices[i]
        return DoublePair(cx + hs * u.x, cy + hs * u.y)
    }

    val verts = ArrayList<DoublePair>()

    // Top border: left-to-right across row 0.
    val p0 = hc(0, 0)
    verts.add(hv(p0.x, p0.y, 4))
    for (c in 0..lastCol) {
        val pt = hc(c, 0)
        verts.add(hv(pt.x, pt.y, 5))
        if (c < lastCol) {
            if (c % 2 == 0) {
                verts.add(hv(pt.x, pt.y, 0))
            } else {
                val pn = hc(c + 1, 0)
                verts.add(hv(pn.x, pn.y, 4))
            }
        }
    }
    // Right wall: top-to-bottom along last col.
    for (r in 0..lastRow) {
        val pr = hc(lastCol, r)
        verts.add(hv(pr.x, pr.y, 0))
        verts.add(hv(pr.x, pr.y, 1))
    }
    // Bottom border: right-to-left across last row.
    var c2 = lastCol
    while (c2 >= 0) {
        val pb = hc(c2, lastRow)
        verts.add(hv(pb.x, pb.y, 2))
        if (c2 > 0) {
            if (c2 % 2 == 0) {
                val pp = hc(c2 - 1, lastRow)
                verts.add(hv(pp.x, pp.y, 1))
            } else {
                verts.add(hv(pb.x, pb.y, 3))
            }
        }
        c2--
    }
    // Left wall: bottom-to-top along col 0.
    var r2 = lastRow
    while (r2 >= 0) {
        val pl = hc(0, r2)
        verts.add(hv(pl.x, pl.y, 3))
        verts.add(hv(pl.x, pl.y, 4))
        r2--
    }

    if (outset != 0.0) {
        val n = verts.size
        val offset = ArrayList<DoublePair>(n)
        for (oi in 0 until n) {
            val prev = verts[(oi - 1 + n) % n]
            val curr = verts[oi]
            val next = verts[(oi + 1) % n]
            var n1x = curr.y - prev.y
            var n1y = prev.x - curr.x
            var n2x = next.y - curr.y
            var n2y = curr.x - next.x
            val s1 = sqrt(n1x * n1x + n1y * n1y)
            val s2 = sqrt(n2x * n2x + n2y * n2y)
            val l1 = if (s1 != 0.0) s1 else 1.0
            val l2 = if (s2 != 0.0) s2 else 1.0
            n1x /= l1; n1y /= l1
            n2x /= l2; n2y /= l2
            val ax = n1x + n2x
            val ay = n1y + n2y
            var dot = ax * n1x + ay * n1y
            if (abs(dot) < 0.001) dot = 1.0
            val scale = outset / dot
            offset.add(DoublePair(curr.x + ax * scale, curr.y + ay * scale))
        }
        return offset
    }
    return verts
}
