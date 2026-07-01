import Foundation

// Board perimeter outline math, ported EXACTLY from server/constants.js
// (computeHexOutlineVerts, lines 194-275). Produces the closed ring of vertices
// that traces the outer edge of the hex board, in canvas Y-down board-local
// coords with board origin at (0, 0).
//
// The optional `outset` pushes each vertex outward along the average of its two
// adjacent edge normals, keeping a uniform perpendicular distance from the
// original outline (used for the wall stroke). outset == 0 returns the raw ring
// (used for the well clip path).
//
// Tuples are returned (rather than CGPoint) to keep this Foundation-only and
// platform-agnostic; the SpriteKit layer applies the Y-axis flip.

public extension HexGeometry {
    /// Outline vertices for the board perimeter, canvas Y-down, origin (0, 0).
    /// - Parameter outset: perpendicular distance to push each vertex outward
    ///   (0 = raw outline). Matches computeHexOutlineVerts in server/constants.js.
    func outlineVertices(outset: Double = 0) -> [(x: Double, y: Double)] {
        let hs = hexSize
        let lastRow = visibleRows - 1
        let lastCol = cols - 1

        // hc(col, row): board origin is (0, 0), so bx = by = 0.
        func hc(_ col: Int, _ row: Int) -> (x: Double, y: Double) {
            return hexCenter(col: col, row: row)
        }
        // hv(cx, cy, i): vertex i of the flat-top hex centered at (cx, cy).
        func hv(_ cx: Double, _ cy: Double, _ i: Int) -> (x: Double, y: Double) {
            let u = HexGeometry.unitVertices[i]
            return (cx + hs * u.x, cy + hs * u.y)
        }

        var verts: [(x: Double, y: Double)] = []

        // Top border: left-to-right across row 0
        let p0 = hc(0, 0)
        verts.append(hv(p0.x, p0.y, 4))
        for c in 0...lastCol {
            let pt = hc(c, 0)
            verts.append(hv(pt.x, pt.y, 5))
            if c < lastCol {
                if c % 2 == 0 {
                    verts.append(hv(pt.x, pt.y, 0))
                } else {
                    let pn = hc(c + 1, 0)
                    verts.append(hv(pn.x, pn.y, 4))
                }
            }
        }
        // Right wall: top-to-bottom along last col
        for r in 0...lastRow {
            let pr = hc(lastCol, r)
            verts.append(hv(pr.x, pr.y, 0))
            verts.append(hv(pr.x, pr.y, 1))
        }
        // Bottom border: right-to-left across last row
        var c2 = lastCol
        while c2 >= 0 {
            let pb = hc(c2, lastRow)
            verts.append(hv(pb.x, pb.y, 2))
            if c2 > 0 {
                if c2 % 2 == 0 {
                    let pp = hc(c2 - 1, lastRow)
                    verts.append(hv(pp.x, pp.y, 1))
                } else {
                    verts.append(hv(pb.x, pb.y, 3))
                }
            }
            c2 -= 1
        }
        // Left wall: bottom-to-top along col 0
        var r2 = lastRow
        while r2 >= 0 {
            let pl = hc(0, r2)
            verts.append(hv(pl.x, pl.y, 3))
            verts.append(hv(pl.x, pl.y, 4))
            r2 -= 1
        }

        // Offset each vertex outward along the average normal of its two adjacent
        // edges. This ensures uniform perpendicular distance from the original
        // outline. (JS: `if (outset)` is a truthy check, so outset == 0 is a no-op.)
        if outset != 0 {
            let n = verts.count
            var offset: [(x: Double, y: Double)] = []
            offset.reserveCapacity(n)
            for oi in 0..<n {
                let prev = verts[(oi - 1 + n) % n]
                let curr = verts[oi]
                let next = verts[(oi + 1) % n]
                // Edge normals (outward = right-hand perpendicular for CW winding)
                var n1x = curr.y - prev.y, n1y = prev.x - curr.x
                var n2x = next.y - curr.y, n2y = curr.x - next.x
                // JS `Math.sqrt(...) || 1`: fall back to 1 when length is 0.
                let s1 = (n1x * n1x + n1y * n1y).squareRoot()
                let s2 = (n2x * n2x + n2y * n2y).squareRoot()
                let l1 = s1 != 0 ? s1 : 1
                let l2 = s2 != 0 ? s2 : 1
                n1x /= l1; n1y /= l1
                n2x /= l2; n2y /= l2
                // Average normal, scaled to maintain perpendicular offset distance
                let ax = n1x + n2x, ay = n1y + n2y
                var dot = ax * n1x + ay * n1y
                if abs(dot) < 0.001 { dot = 1 }
                let scale = outset / dot
                offset.append((curr.x + ax * scale, curr.y + ay * scale))
            }
            return offset
        }

        return verts
    }
}
