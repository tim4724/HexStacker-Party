import SpriteKit
import HexStackerKit

/// A small circular focusable ⓘ button — the lobby entry to the About screen
/// (Privacy / Imprint QR + Licenses). Icon-only, so there is no TV-only
/// string to mirror. Focus adds a bright ring + slight scale, matching MenuButton's
/// focus convention. Navigable with the Siri Remote d-pad like any other Focusable.
final class InfoButton: SKNode, Focusable {
    let action: () -> Void
    let enabled: Bool = true

    private let ring = SKShapeNode()

    init(diameter: CGFloat, action: @escaping () -> Void) {
        self.action = action
        super.init()

        let r = diameter / 2
        // The disc + drawn "i" glyph are baked into one texture (Core Graphics
        // gives crisp, coverage-antialiased edges); live SKShapeNode fills render
        // pixely at this size and blur further when scaled on focus. Same
        // texture-bake pattern as MenuButton / MusicSwitch.
        // Round utility button (A2 .icon-btn): recessed translucent disc +
        // warm hairline ring, not a card-colored chip.
        let face = SKSpriteNode(texture: Self.bakeFace(diameter: diameter,
                                                       disc: SKTheme.socket(0.4),
                                                       glyph: SKTheme.textPrimary()))
        face.size = CGSize(width: diameter, height: diameter)
        face.zPosition = 0
        addChild(face)

        ring.path = CGPath(ellipseIn: CGRect(x: -r, y: -r, width: diameter, height: diameter), transform: nil)
        ring.fillColor = .clear
        ring.isAntialiased = true
        ring.zPosition = 1
        addChild(ring)

        setFocused(false)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    func activate() { action() }

    func setFocused(_ focused: Bool) {
        ring.strokeColor = focused ? .white : SKTheme.hairline(0.12)
        ring.lineWidth = focused ? 4 : 1
        setScale(focused ? 1.06 : 1.0)
    }

    /// The circular card + drawn info glyph (dot + rounded stem), baked at device
    /// scale for crisp edges. The glyph is drawn rather than set as a font letter,
    /// so it reads as an icon and matches the Android button regardless of the font.
    private static func bakeFace(diameter: CGFloat, disc: UIColor, glyph: UIColor) -> SKTexture {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: diameter, height: diameter))
        let image = renderer.image { rctx in
            let ctx = rctx.cgContext
            let r = diameter / 2
            ctx.setFillColor(disc.cgColor)
            ctx.fillEllipse(in: CGRect(x: 0, y: 0, width: diameter, height: diameter))

            let unit = diameter * 0.13     // dot diameter == stem width
            let stemH = diameter * 0.3
            let gap = diameter * 0.055
            let glyphTop = r - (unit + gap + stemH) / 2   // glyph vertically centered
            ctx.setFillColor(glyph.cgColor)
            ctx.fillEllipse(in: CGRect(x: r - unit / 2, y: glyphTop, width: unit, height: unit))
            let stemRect = CGRect(x: r - unit / 2, y: glyphTop + unit + gap, width: unit, height: stemH)
            ctx.addPath(UIBezierPath(roundedRect: stemRect, cornerRadius: unit / 2).cgPath)
            ctx.fillPath()
        }
        return SKTexture(image: image)
    }
}
