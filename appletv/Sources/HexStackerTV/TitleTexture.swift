import UIKit
import HexStackerKit

/// Bakes the HEX STACKER wordmark as an image: the 8-stop party-palette gradient
/// (135°) clipped to the glyphs, with a cream "PARTY" subtitle below. SpriteKit
/// labels cannot gradient-fill text, so the wordmark is rendered to an SKTexture.
/// Mirrors `.gradient-title` / `.gradient-title__sub` in theme.css.
enum TitleTexture {
    // PLAYER_COLORS spectrum order — identical to the .gradient-title stops.
    private static let stops: [RGB] = [
        RGB(0xFF, 0x6B, 0x6B), RGB(0xFF, 0x8C, 0x42), RGB(0xFF, 0xE0, 0x66), RGB(0x7B, 0xED, 0x6F),
        RGB(0x4E, 0xCD, 0xC4), RGB(0x5B, 0x7F, 0xFF), RGB(0xA7, 0x8B, 0xFA), RGB(0xF1, 0x78, 0xD8),
    ]

    /// `mainSize` is the wordmark font size in points. Returns an opaque-on-clear
    /// image sized to fit the wordmark + subtitle (centered, with padding).
    static func make(main: String = "HEX STACKER", sub: String = "PARTY", mainSize: CGFloat) -> UIImage {
        let subSize = mainSize * 0.42
        let mainFont = UIFont(name: AppFont.black, size: mainSize) ?? .systemFont(ofSize: mainSize, weight: .black)
        let subFont = UIFont(name: AppFont.semibold, size: subSize) ?? .systemFont(ofSize: subSize, weight: .semibold)

        // letter-spacing: main 0.08em, sub 0.35em (theme.css).
        let mainAttr: [NSAttributedString.Key: Any] = [
            .font: mainFont, .kern: mainSize * 0.08, .foregroundColor: UIColor.white,
        ]
        let subAttr: [NSAttributedString.Key: Any] = [
            .font: subFont, .kern: subSize * 0.35, .foregroundColor: UIColor(RGB(0xFF, 0xF3, 0xC2)),
        ]
        let mainStr = NSAttributedString(string: main, attributes: mainAttr)
        let subStr = NSAttributedString(string: sub, attributes: subAttr)
        let mainBounds = mainStr.size()
        let subBounds = subStr.size()

        let gap = mainSize * 0.22
        let pad = mainSize * 0.32   // glyph overshoot + drop-shadow headroom
        let w = ceil(max(mainBounds.width, subBounds.width) + pad * 2)
        let h = ceil(mainBounds.height + gap + subBounds.height + pad * 2)

        let size = CGSize(width: w, height: h)
        let format = UIGraphicsImageRendererFormat.preferred()
        format.opaque = false
        let mainOrigin = CGPoint(x: (w - mainBounds.width) / 2, y: pad)

        // 1. Render the wordmark glyphs to their own image (white on clear).
        //    Drawing text directly under a destination-in blend does NOT work —
        //    UIKit text drawing forces .normal blend — so the mask must be an
        //    image, which `draw(at:)` composites honoring the blend mode.
        let mask = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            mainStr.draw(at: mainOrigin)
        }

        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        return renderer.image { rctx in
            let ctx = rctx.cgContext

            // 2. Fill with the 135° party-palette gradient, then keep it only
            //    where the glyph mask is opaque (destination-in).
            ctx.saveGState()
            let colors = stops.map { UIColor($0).cgColor } as CFArray
            let locs: [CGFloat] = (0..<stops.count).map { CGFloat($0) / CGFloat(stops.count - 1) }
            if let grad = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: locs) {
                ctx.drawLinearGradient(
                    grad,
                    start: CGPoint(x: 0, y: mainOrigin.y),
                    end: CGPoint(x: w, y: mainOrigin.y + mainBounds.height),
                    options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
            }
            // draw(at:blendMode:alpha:) honors the blend mode; the plain
            // draw(at:) variant always composites with .normal.
            mask.draw(at: .zero, blendMode: .destinationIn, alpha: 1)
            ctx.restoreGState()

            // 3. Subtitle below, plain cream.
            let subOrigin = CGPoint(x: (w - subBounds.width) / 2, y: mainOrigin.y + mainBounds.height + gap)
            subStr.draw(at: subOrigin)
        }
    }
}
