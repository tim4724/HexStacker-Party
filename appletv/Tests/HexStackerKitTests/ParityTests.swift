import Testing
import Foundation
@testable import HexStackerKit

/// Cross-engine parity: the native Swift render math must equal the web JS
/// render math (run in JavaScriptCore). Guarantees both rendering engines place
/// the same colored hex in the same cell.
@Suite struct ParityTests {

    private func makeJS() throws -> RenderMathJS {
        let repo = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        return try RenderMathJS(serverDir: repo.appendingPathComponent("server"),
                                sharedDir: repo.appendingPathComponent("public/shared"))
    }

    @Test func geometryMatches() throws {
        let js = try makeJS()
        for cs in [10.0, 14.0, 20.0, 33.0] {
            let j = js.geometry(cellSize: cs)
            let s = HexGeometry(cellSize: cs)
            #expect(abs(j.hexSize - s.hexSize) < 1e-6)
            #expect(abs(j.hexH - s.hexH) < 1e-6)
            #expect(abs(j.colW - s.colW) < 1e-6)
            #expect(abs(j.boardWidth - s.boardWidth) < 1e-6)
            #expect(abs(j.boardHeight - s.boardHeight) < 1e-6)
        }
    }

    @Test func cellCentersMatch() throws {
        let js = try makeJS()
        let g = HexGeometry(cellSize: 20)
        for (col, row) in [(0, 0), (1, 0), (4, 7), (8, 14), (3, 11)] {
            let j = js.hexCenter(col: col, row: row, cellSize: 20)
            let s = g.hexCenter(col: col, row: row)
            #expect(abs(j.x - s.x) < 1e-6 && abs(j.y - s.y) < 1e-6)
        }
    }

    @Test func paletteMatches() throws {
        let js = try makeJS()
        let piece = js.pieceColors()
        for id in [1, 2, 3, 4, 5, 6, 9] { #expect(piece[id] == Theme.pieceColors[id]) }
        let players = js.playerColors()
        #expect(players == Theme.playerColors)
    }

    @Test func styleTiersMatch() throws {
        let js = try makeJS()
        func name(_ t: Theme.StyleTier) -> String {
            switch t { case .normal: return "normal"; case .pillow: return "pillow"; case .neonFlat: return "neonFlat" }
        }
        for level in [1, 5, 6, 10, 11, 15] {
            #expect(js.styleTier(level: level) == name(Theme.tier(forLevel: level)))
        }
    }

    @Test func colorMathMatches() throws {
        let js = try makeJS()
        #expect(js.lighten("#646464", 15) == ColorMath.lighten(RGB(100, 100, 100), 15))
        #expect(js.darken("#646464", 10) == ColorMath.darken(RGB(100, 100, 100), 10))
        let jg = try #require(js.ghost("#FF6B6B"))
        let sg = ColorMath.ghost(RGB(255, 107, 107))
        #expect(jg.rgb == sg.rgb)
        #expect(abs(jg.outlineAlpha - sg.outlineAlpha) < 1e-9)
        #expect(abs(jg.fillAlpha - sg.fillAlpha) < 1e-9)
    }

    /// The board-perimeter outline (the wall stroke and the well clip ring) is
    /// the most intricate hand-ported render math; pin it to
    /// computeHexOutlineVerts for both the raw ring (outset 0) and the
    /// average-normal outward-offset ring (outset > 0).
    @Test func boardOutlineMatches() throws {
        let js = try makeJS()
        for cs in [14.0, 20.0] {
            let g = HexGeometry(cellSize: cs)
            for outset in [0.0, 2.5] {
                let j = js.outline(cellSize: cs, outset: outset)
                let s = g.outlineVertices(outset: outset)
                try #require(j.count == s.count, "vertex count (cs \(cs), outset \(outset))")
                for (jv, sv) in zip(j, s) {
                    #expect(abs(jv.x - sv.x) < 1e-6 && abs(jv.y - sv.y) < 1e-6,
                            "vertex mismatch at cs \(cs), outset \(outset)")
                }
            }
        }
    }

    /// The zigzag clear-detection ports (used for the on-board clear preview and
    /// near-clear pulse) must equal constants.js byte-for-byte, including the
    /// bottom-first overlap ordering and ghost-completion filter.
    @Test func zigzagDetectionMatches() throws {
        let js = try makeJS()
        let cols = 9, rows = 15
        func empty() -> [[Int]] { Array(repeating: Array(repeating: 0, count: cols), count: rows) }
        func filled(_ g: [[Int]]) -> (Int, Int) -> Bool { { g[$1][$0] > 0 } }

        var gA = empty(); for c in 0..<cols { gA[rows - 1][c] = (c % 6) + 1 }
        #expect(js.clearable(grid: gA, cols: cols, ghost: nil)
                == Zigzag.clearable(cols: cols, totalRows: rows, isFilled: filled(gA)))
        #expect(js.nearClear(grid: gA, cols: cols)
                == Zigzag.nearClear(cols: cols, totalRows: rows, isFilled: filled(gA)))

        var gB = empty(); for c in 0..<cols where c != 3 { gB[rows - 1][c] = (c % 6) + 1 }
        #expect(js.nearClear(grid: gB, cols: cols)
                == Zigzag.nearClear(cols: cols, totalRows: rows, isFilled: filled(gB)))

        let ghost = [Cell(col: 3, row: rows - 1)]
        let gset = Set(ghost.map { $0.col * 100 + $0.row })
        let cF: (Int, Int) -> Bool = { gB[$1][$0] > 0 || gset.contains($0 * 100 + $1) }
        let cG: (Int, Int) -> Bool = { gB[$1][$0] == 0 && gset.contains($0 * 100 + $1) }
        #expect(js.clearable(grid: gB, cols: cols, ghost: ghost)
                == Zigzag.clearable(cols: cols, totalRows: rows, isFilled: cF, ghostContributes: cG))

        var gD = empty()
        for c in 0..<cols { gD[(c & 1) == 1 ? rows - 2 : rows - 1][c] = (c % 6) + 1 }
        for c in 0..<cols { gD[rows - 3][c] = (c % 6) + 1 }
        #expect(js.clearable(grid: gD, cols: cols, ghost: nil)
                == Zigzag.clearable(cols: cols, totalRows: rows, isFilled: filled(gD)))
        #expect(js.nearClear(grid: gD, cols: cols)
                == Zigzag.nearClear(cols: cols, totalRows: rows, isFilled: filled(gD)))
    }
}
