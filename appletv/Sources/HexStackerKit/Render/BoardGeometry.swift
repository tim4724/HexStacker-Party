import Foundation

// Pure hex-board geometry, ported from server/constants.js (computeHexGeometry,
// computeHexOutlineVerts) and public/display/DisplayUI.js (calculateLayout).
// Platform-agnostic so it is unit-checkable on macOS; the SpriteKit layer adds
// the Y-axis flip (these formulas are in canvas Y-down, board-local space).

public struct HexGeometry: Equatable {
    public let cellSize: Double
    public let cols: Int
    public let visibleRows: Int

    public let hexSize: Double      // circumradius (center -> vertex)
    public let hexH: Double         // full hex height (√3 · hexSize)
    public let colW: Double         // horizontal column pitch (1.5 · hexSize)
    public let hexW: Double         // full hex width (2 · hexSize)
    public let boardWidth: Double
    public let boardHeight: Double

    public let sCell: Double        // drawn cell circumradius (with block gap)
    public let stampHeight: Double  // drawn cell height (√3 · sCell)
    public let gridLineWidth: Double
    public let borderWidth: Double
    public let wallOutset: Double

    public init(cellSize: Double,
                cols: Int = EngineConstants.cols,
                visibleRows: Int = EngineConstants.visibleRows) {
        let c = Double(cols)
        let v = Double(visibleRows)
        let sqrt3 = 3.0.squareRoot()

        self.cellSize = cellSize
        self.cols = cols
        self.visibleRows = visibleRows

        self.hexSize = c * cellSize / (1.5 * c + 0.5)
        self.hexH = sqrt3 * hexSize
        self.colW = 1.5 * hexSize
        self.hexW = 2 * hexSize
        self.boardWidth = colW * (c - 1) + 2 * hexSize
        self.boardHeight = hexH * (v - 1) + hexH + hexH * 0.5

        // Theme.size.blockGap = 0.03 (half-gap vs apothem), stroke tokens.
        self.sCell = hexSize - cellSize * 0.03 * 2 / sqrt3
        self.stampHeight = sqrt3 * sCell
        self.gridLineWidth = stampHeight * 0.03      // Theme.stroke.grid
        self.borderWidth = cellSize * 0.04           // Theme.stroke.border
        self.wallOutset = cellSize * 0.02
    }

    /// Board-local pixel center of cell (col, row), canvas Y-down. Odd columns
    /// are staggered DOWN by half a hex (flat-top, column-staggered layout).
    public func hexCenter(col: Int, row: Int) -> (x: Double, y: Double) {
        let x = colW * Double(col) + hexSize
        let y = hexH * (Double(row) + 0.5 * Double(col & 1)) + hexH / 2
        return (x, y)
    }

    /// Flat-top unit hex vertices (circumradius 1), canvas Y-down.
    /// Vertex i at angle 60°·i; index 0 and 3 are the left/right points.
    public static let unitVertices: [(x: Double, y: Double)] = (0..<6).map { i in
        let a = Double.pi / 3 * Double(i)
        return (cos(a), sin(a))
    }
}

// MARK: - Color utilities (replicated exactly from public/shared/CanvasUtils.js)

public struct RGB: Equatable {
    public let r: Int
    public let g: Int
    public let b: Int

    public init(_ r: Int, _ g: Int, _ b: Int) {
        self.r = r; self.g = g; self.b = b
    }

    /// Parse "#rrggbb" (or "rrggbb"). Returns nil if malformed.
    public init?(hex: String) {
        var s = hex
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6, let v = Int(s, radix: 16) else { return nil }
        self.init((v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF)
    }
}

public enum ColorMath {
    /// lightenColor(hex, percent): scale each channel by (1 + percent/100), clamp to 255.
    public static func lighten(_ c: RGB, _ percent: Double) -> RGB {
        let f = 1 + percent / 100
        return RGB(min(255, Int((Double(c.r) * f).rounded())),
                   min(255, Int((Double(c.g) * f).rounded())),
                   min(255, Int((Double(c.b) * f).rounded())))
    }

    /// darkenColor(hex, percent): scale each channel by (1 - percent/100), no clamp.
    public static func darken(_ c: RGB, _ percent: Double) -> RGB {
        let f = 1 - percent / 100
        return RGB(Int((Double(c.r) * f).rounded()),
                   Int((Double(c.g) * f).rounded()),
                   Int((Double(c.b) * f).rounded()))
    }

    /// NEON_FLAT dark fill: 30% of color, truncated toward zero (matches `| 0`).
    public static func neonDark(_ c: RGB) -> RGB {
        RGB(Int(Double(c.r) * 0.3), Int(Double(c.g) * 0.3), Int(Double(c.b) * 0.3))
    }

    /// Perceptual luminance in 0...1.
    public static func luminance01(_ c: RGB) -> Double {
        (Double(c.r) * 0.299 + Double(c.g) * 0.587 + Double(c.b) * 0.114) / 255
    }

    public struct Ghost: Equatable {
        public let rgb: RGB
        public let outlineAlpha: Double
        public let fillAlpha: Double
    }

    /// ghostColor(hex): lighten 30% toward white (floor 80), alpha from luminance.
    public static func ghost(_ c: RGB) -> Ghost {
        func chan(_ x: Int) -> Int { min(255, max(80, Int((Double(x) + (255 - Double(x)) * 0.3).rounded()))) }
        let lum = luminance01(c)
        let a = ((0.3 + (1 - lum) * 0.15) * 100).rounded() / 100
        let fillA = (a * 0.5 * 100).rounded() / 100
        return Ghost(rgb: RGB(chan(c.r), chan(c.g), chan(c.b)), outlineAlpha: a, fillAlpha: fillA)
    }
}
