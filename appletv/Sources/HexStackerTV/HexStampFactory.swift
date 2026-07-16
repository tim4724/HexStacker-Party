import UIKit
import SpriteKit
import HexStackerKit

/// Renders flat-top hex cell "stamps" with Core Graphics and caches them as
/// SKTextures, one per (tier, color, size). Ported from the stamp recipes in
/// public/shared/CanvasUtils.js (_stampHexNormal / _stampHexPillow /
/// _stampHexNeonFlat). The UIGraphicsImageRenderer context is top-left / Y-down,
/// matching the canvas coordinate space the recipes were written in.
final class HexStampFactory {

    static let shared = HexStampFactory()
    private var cache: [String: SKTexture] = [:]

    private static let v = HexGeometry.unitVertices   // 6 (cos,sin) flat-top vertices

    /// `flatHex`'s drawn circumradius; sprites scale the full texture size by
    /// `radius / flatHexCircumradius` so the pad scales with the hex.
    static let flatHexCircumradius: CGFloat = 32

    /// One shared white flat-top hex fill for effect particles (sparkles, clear
    /// flashes), tinted per sprite via SKSpriteNode color/colorBlendFactor. A
    /// single texture for every particle color lets SpriteKit batch them all
    /// into one draw call, where an SKShapeNode per particle is an unbatched
    /// draw plus a CPU tessellation each. Sized generously and scaled down by
    /// the sprite (particles run tiny, so linear filtering stays clean).
    lazy var flatHex: SKTexture = {
        let cr = Self.flatHexCircumradius
        let pad: CGFloat = 1                        // keep the AA edge off the bitmap border
        let w = 2 * cr + 2 * pad
        let h = CGFloat(3.0.squareRoot()) * cr + 2 * pad
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: w, height: h))
        let image = renderer.image { rctx in
            let ctx = rctx.cgContext
            ctx.addPath(hexPath(cx: w / 2, cy: h / 2, r: cr))
            ctx.setFillColor(UIColor.white.cgColor)
            ctx.fillPath()
        }
        let texture = SKTexture(image: image)
        texture.filteringMode = .linear
        return texture
    }()

    /// `size` is the drawn cell HEIGHT (stampHeight). Returns a cached texture.
    func stamp(tier: Theme.StyleTier, color: RGB, size: CGFloat) -> SKTexture {
        let sizeKey = Int((size * 10).rounded())
        let key = "\(tier)_\(color.r),\(color.g),\(color.b)_\(sizeKey)"
        if let cached = cache[key] { return cached }

        let cr = size / CGFloat(3.0.squareRoot())   // circumradius
        let pad = max(2, Int((size * 0.04).rounded(.up)) + 1)
        let w = Int((2 * cr).rounded(.up)) + 2 * pad
        let h = Int(size.rounded(.up)) + 2 * pad
        let cx = cr + CGFloat(pad)
        let cy = CGFloat(h) / 2

        let format = UIGraphicsImageRendererFormat.preferred()
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: w, height: h), format: format)
        let image = renderer.image { rctx in
            let ctx = rctx.cgContext
            switch tier {
            case .normal: drawNormal(ctx, cx: cx, cy: cy, cr: cr, size: size, color: color)
            case .pillow: drawPillow(ctx, cx: cx, cy: cy, cr: cr, size: size, color: color)
            case .neonFlat: drawNeon(ctx, cx: cx, cy: cy, cr: cr, size: size, color: color)
            }
        }
        let texture = SKTexture(image: image)
        texture.filteringMode = .linear
        cache[key] = texture
        return texture
    }

    // MARK: - Paths

    private func point(_ cx: CGFloat, _ cy: CGFloat, _ r: CGFloat, _ i: Int) -> CGPoint {
        CGPoint(x: cx + r * CGFloat(Self.v[i].x), y: cy + r * CGFloat(Self.v[i].y))
    }

    private func hexPath(cx: CGFloat, cy: CGFloat, r: CGFloat) -> CGPath {
        let p = CGMutablePath()
        p.move(to: point(cx, cy, r, 0))
        for i in 1..<6 { p.addLine(to: point(cx, cy, r, i)) }
        p.closeSubpath()
        return p
    }

    private func roundedHexPath(cx: CGFloat, cy: CGFloat, r: CGFloat, cornerR: CGFloat) -> CGPath {
        let pts = (0..<6).map { point(cx, cy, r, $0) }
        func mid(_ a: CGPoint, _ b: CGPoint) -> CGPoint { CGPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2) }
        let p = CGMutablePath()
        p.move(to: mid(pts[5], pts[0]))
        for i in 0..<6 {
            let corner = pts[i]
            let next = mid(pts[i], pts[(i + 1) % 6])
            p.addArc(tangent1End: corner, tangent2End: next, radius: cornerR)
        }
        p.closeSubpath()
        return p
    }

    // MARK: - Tier recipes

    private func drawNormal(_ ctx: CGContext, cx: CGFloat, cy: CGFloat, cr: CGFloat, size: CGFloat, color: RGB) {
        let path = hexPath(cx: cx, cy: cy, r: cr)
        ctx.saveGState()
        ctx.addPath(path); ctx.clip()

        let top = UIColor(ColorMath.lighten(color, 15)).cgColor
        let bottom = UIColor(ColorMath.darken(color, 10)).cgColor
        if let grad = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(),
                                 colors: [top, bottom] as CFArray, locations: [0, 1]) {
            ctx.drawLinearGradient(grad, start: CGPoint(x: cx, y: cy - cr),
                                   end: CGPoint(x: cx, y: cy + cr), options: [])
        }
        // Top highlight + bottom shadow + inner shine. Highlight/shine in warm
        // cream (247,241,232 = text.primary) rather than pure white — cool
        // flashes read as chrome against the warm plum surfaces (CanvasUtils).
        ctx.setFillColor(UIColor(Theme.nearClear, alpha: Theme.Opacity.highlight).cgColor)
        ctx.fill(CGRect(x: cx - cr * 0.5, y: cy - cr * 0.88, width: cr, height: size * 0.08))
        ctx.setFillColor(UIColor(white: 0, alpha: Theme.Opacity.shadow).cgColor)
        ctx.fill(CGRect(x: cx - cr * 0.5, y: cy + cr * 0.76, width: cr, height: size * 0.08))
        let sh = size * 0.35
        ctx.setFillColor(UIColor(Theme.nearClear, alpha: Theme.Opacity.subtle).cgColor)
        ctx.fill(CGRect(x: cx - cr * 0.35, y: cy - cr * 0.5, width: sh, height: sh * 0.36))
        ctx.restoreGState()
    }

    private func drawPillow(_ ctx: CGContext, cx: CGFloat, cy: CGFloat, cr: CGFloat, size: CGFloat, color: RGB) {
        let cornerR = cr * 0.15
        let lineInset = cornerR / CGFloat(3.0.squareRoot())
        let path = roundedHexPath(cx: cx, cy: cy, r: cr, cornerR: cornerR)

        ctx.addPath(path)
        ctx.setFillColor(UIColor(color).cgColor)
        ctx.fillPath()

        ctx.saveGState()
        ctx.addPath(path); ctx.clip()
        if let grad = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(),
                                 colors: [UIColor(white: 1, alpha: 0.3).cgColor,
                                          UIColor(white: 1, alpha: 0).cgColor] as CFArray,
                                 locations: [0, 1]) {
            ctx.drawRadialGradient(grad,
                                   startCenter: CGPoint(x: cx - cr * 0.05, y: cy - cr * 0.1), startRadius: 0,
                                   endCenter: CGPoint(x: cx, y: cy), endRadius: cr * 1.1, options: [])
        }
        ctx.restoreGState()

        // Bottom shadow line across the two lower vertices.
        ctx.setStrokeColor(UIColor(white: 0, alpha: 0.25).cgColor)
        ctx.setLineWidth(max(0.5, size * 0.04))
        let p1 = point(cx, cy, cr, 1), p2 = point(cx, cy, cr, 2)
        ctx.move(to: CGPoint(x: p1.x - lineInset, y: p1.y))
        ctx.addLine(to: CGPoint(x: p2.x + lineInset, y: p2.y))
        ctx.strokePath()
    }

    private func drawNeon(_ ctx: CGContext, cx: CGFloat, cy: CGFloat, cr: CGFloat, size: CGFloat, color: RGB) {
        let path = hexPath(cx: cx, cy: cy, r: cr)
        ctx.addPath(path)
        ctx.setFillColor(UIColor(ColorMath.neonDark(color)).cgColor)
        ctx.fillPath()

        let bw = max(1, size * 0.08)
        ctx.addPath(path)
        ctx.setStrokeColor(UIColor(color).cgColor)
        ctx.setLineWidth(bw)
        ctx.strokePath()

        // Top inner highlight line.
        let insetScale = 1 - bw / cr
        ctx.setAlpha(0.45)
        ctx.setStrokeColor(UIColor(ColorMath.lighten(color, 20)).cgColor)
        ctx.setLineWidth(max(0.5, size * 0.032))
        let a = point(cx, cy, cr * insetScale, 4)
        let b = point(cx, cy, cr * insetScale, 5)
        ctx.move(to: a)
        ctx.addLine(to: b)
        ctx.strokePath()
        ctx.setAlpha(1)
    }
}
