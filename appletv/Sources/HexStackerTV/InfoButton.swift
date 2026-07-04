import SpriteKit
import HexStackerKit

/// A small circular focusable ⓘ button — the lobby entry to the About screen
/// (Privacy / Imprint QR + Open Source Licenses). Icon-only, so there is no TV-only
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
        let disc = SKShapeNode(circleOfRadius: r)
        disc.fillColor = SKTheme.bgCard
        disc.strokeColor = .clear
        disc.zPosition = 0
        addChild(disc)

        ring.path = CGPath(ellipseIn: CGRect(x: -r, y: -r, width: diameter, height: diameter), transform: nil)
        ring.fillColor = .clear
        ring.isAntialiased = true
        ring.zPosition = 1
        addChild(ring)

        // Drawn info glyph (dot + rounded stem) rather than a font letter, so it reads
        // as an icon and matches the Android button regardless of the font.
        let unit = diameter * 0.13     // dot diameter == stem width
        let stemH = diameter * 0.3
        let gap = diameter * 0.055
        let topY = (unit + gap + stemH) / 2   // glyph vertically centered on (0, 0)
        let glyphColor = SKTheme.textPrimary()

        let dot = SKShapeNode(circleOfRadius: unit / 2)
        dot.fillColor = glyphColor
        dot.strokeColor = .clear
        dot.zPosition = 2
        dot.position = CGPoint(x: 0, y: topY - unit / 2)
        addChild(dot)

        let stemRect = CGRect(x: -unit / 2, y: topY - unit - gap - stemH, width: unit, height: stemH)
        let stem = SKShapeNode(path: CGPath(roundedRect: stemRect, cornerWidth: unit / 2,
                                            cornerHeight: unit / 2, transform: nil))
        stem.fillColor = glyphColor
        stem.strokeColor = .clear
        stem.zPosition = 2
        addChild(stem)

        setFocused(false)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    func activate() { action() }

    func setFocused(_ focused: Bool) {
        ring.strokeColor = focused ? .white : SKTheme.borderStrong
        ring.lineWidth = focused ? 4 : 1
        setScale(focused ? 1.06 : 1.0)
    }
}
