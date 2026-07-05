import UIKit
import HexStackerKit

/// Bakes the HEX STACKER title lockup as an image: the party-palette triad mark
/// (public/shared/brand-mark.svg) to the left of a single-color wordmark with a
/// cream "PARTY" subtitle. Mirrors the web display lobby's `.brand-lockup--row`
/// (theme.css). SpriteKit labels can't lay out the mark + text together, so the
/// whole lockup is rendered to an SKTexture.
enum TitleTexture {
    private static let sqrt3 = CGFloat(3).squareRoot()

    /// `mainSize` is the wordmark font size in points. Returns an opaque-on-clear
    /// image sized to fit [mark · wordmark/sub] (mark left, text right, both
    /// vertically centered) with padding.
    static func make(main: String = "HEX STACKER", sub: String = "PARTY", mainSize: CGFloat) -> UIImage {
        let subSize = mainSize * 0.42
        let mainFont = UIFont(name: AppFont.brandExtraBold, size: mainSize) ?? .systemFont(ofSize: mainSize, weight: .heavy)
        let subFont = UIFont(name: AppFont.brandSemibold, size: subSize) ?? .systemFont(ofSize: subSize, weight: .semibold)

        // Colors + letter-spacing from theme.css: wordmark cream #F7F1E8 / 0.06em,
        // sub honey #FFF3C2 / 0.35em.
        let mainAttr: [NSAttributedString.Key: Any] = [
            .font: mainFont, .kern: mainSize * 0.06, .foregroundColor: UIColor(RGB(0xF7, 0xF1, 0xE8)),
        ]
        let subAttr: [NSAttributedString.Key: Any] = [
            .font: subFont, .kern: subSize * 0.35, .foregroundColor: UIColor(RGB(0xFF, 0xF3, 0xC2)),
        ]
        let mainStr = NSAttributedString(string: main, attributes: mainAttr)
        let subStr = NSAttributedString(string: sub, attributes: subAttr)
        let mainBounds = mainStr.size()
        let subBounds = subStr.size()

        // Text block: main over sub, left-aligned; the sub sits 0.1em (of its own
        // size) below the wordmark (web .brand-lockup__sub margin-top: 0.1em).
        let subGap = subSize * 0.1
        let textW = max(mainBounds.width, subBounds.width)
        let textH = mainBounds.height + subGap + subBounds.height

        // Triad mark on the left; row gap 0.5em of the main size (.brand-lockup--row).
        // markW is the mark bbox width for the packing drawMark lays out (3.5R wide,
        // 2√3·R tall).
        let markH = mainSize * 1.7
        let markW = markH * 3.5 / (2 * sqrt3)
        let gap = mainSize * 0.5

        let lockupW = markW + gap + textW
        let lockupH = max(markH, textH)

        let pad = mainSize * 0.3   // glyph overshoot headroom
        let w = ceil(lockupW + pad * 2)
        let h = ceil(lockupH + pad * 2)
        let size = CGSize(width: w, height: h)

        let format = UIGraphicsImageRendererFormat.preferred()
        format.opaque = false
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        return renderer.image { rctx in
            let ctx = rctx.cgContext
            let centerY = h / 2

            // Mark bbox vertically centered on the lockup.
            drawMark(ctx, originX: pad, topY: centerY - markH / 2, markHeight: markH)

            // Text block vertically centered against the mark.
            let textLeft = pad + markW + gap
            let textTop = centerY - textH / 2
            // Center each line within the text block (web text-align: center);
            // the trailing kern after the last glyph is already inside size().
            mainStr.draw(at: CGPoint(x: textLeft + (textW - mainBounds.width) / 2, y: textTop))
            subStr.draw(at: CGPoint(
                x: textLeft + (textW - subBounds.width) / 2,
                y: textTop + mainBounds.height + subGap
            ))
        }
    }

    // MARK: - Triad mark

    /// Draws the three flat-top pillow hexes at the mark's top-left `origin`.
    /// `markHeight` is the total mark height (= 1.7 · mainSize). R is the packing
    /// circumradius (2√3·R spans the height); cells are drawn at 0.94R so the
    /// pillows read as separate tiles. Layout mirrors brand-mark.svg: teal top-left,
    /// red directly below it, honey right-of-centre. The context is Y-down (UIKit),
    /// so "top" is the smaller y — teal ends up highest, the highlights bias upward.
    private static func drawMark(_ ctx: CGContext, originX: CGFloat, topY: CGFloat, markHeight: CGFloat) {
        let R = markHeight / (2 * sqrt3)
        let drawR = 0.94 * R
        // origin is the mark bbox top-left; the bbox spans x:[-R, 2.5R] and
        // y:[-(√3/2)R, 1.5√3·R] around teal at (0,0), so shift into texture space.
        let baseX = originX + R
        let baseY = topY + sqrt3 / 2 * R
        let teal = CGPoint(x: baseX, y: baseY)
        let red = CGPoint(x: baseX, y: baseY + sqrt3 * R)
        let honey = CGPoint(x: baseX + 1.5 * R, y: baseY + sqrt3 / 2 * R)
        drawCell(ctx, center: teal, drawR: drawR, color: RGB(0x4E, 0xCD, 0xC4))
        drawCell(ctx, center: red, drawR: drawR, color: RGB(0xFF, 0x6B, 0x6B))
        drawCell(ctx, center: honey, drawR: drawR, color: RGB(0xFF, 0xE0, 0x66))
    }

    private static func drawCell(_ ctx: CGContext, center: CGPoint, drawR: CGFloat, color: RGB) {
        let path = roundedHexPath(cx: center.x, cy: center.y, r: drawR, cornerR: drawR * 0.15)

        ctx.addPath(path)
        ctx.setFillColor(UIColor(color).cgColor)
        ctx.fillPath()

        // Pillow highlight: a soft white radial biased toward the cell's top edge,
        // centered at (0.38, 0.26) of the cell bbox, fading white 30% → 0%.
        ctx.saveGState()
        ctx.addPath(path); ctx.clip()
        let bboxW = 2 * drawR, bboxH = sqrt3 * drawR
        let hl = CGPoint(x: center.x - drawR + 0.38 * bboxW,
                         y: center.y - bboxH / 2 + 0.26 * bboxH)
        if let grad = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(),
                                 colors: [UIColor(white: 1, alpha: 0.3).cgColor,
                                          UIColor(white: 1, alpha: 0).cgColor] as CFArray,
                                 locations: [0, 1]) {
            ctx.drawRadialGradient(grad, startCenter: hl, startRadius: 0,
                                   endCenter: hl, endRadius: bboxW * 0.95, options: [])
        }
        ctx.restoreGState()

        // Bottom-edge contact shadow across the central span of the lower flat.
        ctx.setStrokeColor(UIColor(white: 0, alpha: 0.22).cgColor)
        ctx.setLineWidth(drawR * 0.08)
        let by = center.y + bboxH / 2
        ctx.move(to: CGPoint(x: center.x - drawR * 0.42, y: by))
        ctx.addLine(to: CGPoint(x: center.x + drawR * 0.42, y: by))
        ctx.strokePath()
    }

    /// Flat-top hexagon with tangent-arc rounded corners (same recipe as
    /// HexStampFactory.roundedHexPath): trace midpoint→corner→midpoint using
    /// addArc(tangent1End:) so each corner rounds by `cornerR`.
    private static func roundedHexPath(cx: CGFloat, cy: CGFloat, r: CGFloat, cornerR: CGFloat) -> CGPath {
        let pts = (0..<6).map { i -> CGPoint in
            let a = CGFloat.pi / 3 * CGFloat(i)
            return CGPoint(x: cx + r * cos(a), y: cy + r * sin(a))
        }
        func mid(_ a: CGPoint, _ b: CGPoint) -> CGPoint { CGPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2) }
        let p = CGMutablePath()
        p.move(to: mid(pts[5], pts[0]))
        for i in 0..<6 {
            p.addArc(tangent1End: pts[i], tangent2End: mid(pts[i], pts[(i + 1) % 6]), radius: cornerR)
        }
        p.closeSubpath()
        return p
    }
}
