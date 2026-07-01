import Foundation

// Zigzag clear detection, ported byte-for-byte from server/constants.js
// (findClearableZigzags / findNearClearZigzags). The engine uses these to clear
// lines; the renderer uses them for two on-board feedback effects:
//   • clear preview  — cells that WILL clear when the ghost piece lands
//   • near-clear pulse — empty cells one drop away from completing a zigzag
// Keeping them in HexStackerKit means they are unit/parity-checkable on macOS
// and stay byte-identical to the canonical JS (see ParityTests).
public enum Zigzag {

    /// Check whether a single zigzag line is full. `up == false` ("down"): the
    /// same row index across all columns. `up == true`: even columns at row r,
    /// odd columns at row r-1. Returns the line's cells, or nil if not full.
    /// Mirrors constants.js `checkZigzag`.
    private static func check(_ r: Int, up: Bool, cols: Int, totalRows: Int,
                             isFilled: (Int, Int) -> Bool) -> [Cell]? {
        for col in 0..<cols {
            let row = (up && (col & 1) == 1) ? r - 1 : r
            if row < 0 || row >= totalRows { return nil }
            if !isFilled(col, row) { return nil }
        }
        var cells: [Cell] = []
        cells.reserveCapacity(cols)
        for c in 0..<cols {
            let rr = (up && (c & 1) == 1) ? r - 1 : r
            cells.append(Cell(col: c, row: rr))
        }
        return cells
    }

    /// All clearable zigzag lines (both directions) with bottom-first,
    /// non-overlapping greedy selection. When `ghostContributes` is supplied a
    /// zigzag is only kept if at least one of its cells is a ghost cell (the
    /// renderer's clear-preview filter); pass nil to skip that filter (engine).
    /// Returns the flat list of cells to clear, in selection/scan order — the
    /// exact ordering produced by constants.js `findClearableZigzags`.
    public static func clearable(cols: Int, totalRows: Int,
                                 isFilled: (Int, Int) -> Bool,
                                 ghostContributes: ((Int, Int) -> Bool)? = nil,
                                 minRow: Int = 0) -> [Cell] {
        var all: [[Cell]] = []
        for r in minRow..<totalRows {
            if let down = check(r, up: false, cols: cols, totalRows: totalRows, isFilled: isFilled) {
                if ghostContributes == nil || down.contains(where: { ghostContributes!($0.col, $0.row) }) {
                    all.append(down)
                }
            }
            if r >= 1, let up = check(r, up: true, cols: cols, totalRows: totalRows, isFilled: isFilled) {
                if ghostContributes == nil || up.contains(where: { ghostContributes!($0.col, $0.row) }) {
                    all.append(up)
                }
            }
        }

        // Sort bottom-first: higher max row first (lower on board = higher
        // priority); tie-break by higher min row so a down-zigzag (all at row r)
        // wins over an up-zigzag (spanning r-1..r). Distinct zigzags never tie
        // on both keys, so the result is deterministic regardless of sort
        // stability — matching the JS `(bMax-aMax) || (bMin-aMin)` comparator.
        all.sort { a, b in
            let aMax = a.map { $0.row }.max() ?? 0
            let bMax = b.map { $0.row }.max() ?? 0
            if aMax != bMax { return aMax > bMax }
            let aMin = a.map { $0.row }.min() ?? 0
            let bMin = b.map { $0.row }.min() ?? 0
            return aMin > bMin
        }

        // Greedy non-overlapping selection. Key shifts row by +1 so buffer-zone
        // negative rows stay collision-free.
        let stride = totalRows + 2
        func key(_ c: Cell) -> Int { c.col * stride + (c.row + 1) }
        var used = Set<Int>()
        var out: [Cell] = []
        for zag in all {
            var overlaps = false
            for c in zag where used.contains(key(c)) { overlaps = true; break }
            if overlaps { continue }
            for c in zag { used.insert(key(c)); out.append(c) }
        }
        return out
    }

    /// Empty cells where filling that single cell would complete a zigzag (down
    /// or up). A cell that is the sole gap of more than one zigzag appears once.
    /// Returns cells in scan order (row ascending, down before up). Mirrors
    /// constants.js `findNearClearZigzags`.
    public static func nearClear(cols: Int, totalRows: Int,
                                 isFilled: (Int, Int) -> Bool,
                                 minRow: Int = 0) -> [Cell] {
        let stride = totalRows + 2
        var seen = Set<Int>()
        var out: [Cell] = []

        func scan(_ r: Int, up: Bool) {
            var gap: Cell?
            for col in 0..<cols {
                let row = (up && (col & 1) == 1) ? r - 1 : r
                if row < 0 || row >= totalRows { return }
                if !isFilled(col, row) {
                    if gap != nil { return }   // 2+ empty cells: not a completer
                    gap = Cell(col: col, row: row)
                }
            }
            guard let g = gap else { return }  // already complete
            let k = g.col * stride + (g.row + 1)
            if seen.insert(k).inserted { out.append(g) }
        }

        for r in minRow..<totalRows {
            scan(r, up: false)
            if r >= 1 { scan(r, up: true) }
        }
        return out
    }
}
