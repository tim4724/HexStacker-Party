import UIKit
import HexStackerKit

/// Bakes the HEX STACKER title as an image: a single-color wordmark with a
/// cream "PARTY" subtitle (web `.brand-lockup`; since A2 the triad mark lives
/// as a separate corner badge — see `markImage`). SpriteKit labels can't
/// kern/stack the two lines, so the lockup is rendered to an SKTexture.
enum TitleTexture {
    private static let sqrt3 = CGFloat(3).squareRoot()

    /// `mainSize` is the wordmark font size in points. Returns an opaque-on-clear
    /// image of the pure wordmark + PARTY sub, centered, with padding.
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

        // Text block: main over sub. Web crops Baloo's tall natural line box with
        // `.brand-lockup { line-height: 1.1 }`; NSAttributedString.size() reports
        // the *natural* box (~1.6em), so stacking the sub below it drops PARTY
        // ~0.35em too far. Stack on 1.1em line boxes (with the sub's 0.1em-of-sub
        // gap) and center each string's natural box inside its line box below.
        let subGap = subSize * 0.1
        let mainLineH = mainSize * 1.1
        let subLineH = subSize * 1.1
        let textW = max(mainBounds.width, subBounds.width)
        let textH = mainLineH + subGap + subLineH

        let pad = mainSize * 0.3   // glyph overshoot headroom
        let w = ceil(textW + pad * 2)
        let h = ceil(textH + pad * 2)
        let size = CGSize(width: w, height: h)

        let format = UIGraphicsImageRendererFormat.preferred()
        format.opaque = false
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        return renderer.image { _ in
            let textTop = h / 2 - textH / 2
            // Center each line within the text block (web text-align: center);
            // the trailing kern after the last glyph is already inside size().
            // The y offset centers the string's natural line box inside the 1.1em
            // line box (CSS half-leading), so the baseline lands where the web's
            // line-height:1.1 puts it and PARTY sits tight under the wordmark.
            mainStr.draw(at: CGPoint(
                x: pad + (textW - mainBounds.width) / 2,
                y: textTop + (mainLineH - mainBounds.height) / 2
            ))
            subStr.draw(at: CGPoint(
                x: pad + (textW - subBounds.width) / 2,
                y: textTop + mainLineH + subGap + (subLineH - subBounds.height) / 2
            ))
        }
    }

    /// The triad mark alone (web .brand-badge: the corner badge now that the
    /// h1 is the pure wordmark). `width` is the mark bbox width; the bbox is
    /// 3.5R × 2√3·R, mirroring brand-mark.svg's proportions.
    static func markImage(width: CGFloat) -> UIImage {
        let R = width / 3.5
        let markH = 2 * sqrt3 * R
        let size = CGSize(width: ceil(width), height: ceil(markH))
        let format = UIGraphicsImageRendererFormat.preferred()
        format.opaque = false
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        return renderer.image { rctx in
            drawMark(rctx.cgContext, originX: 0, topY: 0, markHeight: markH)
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
