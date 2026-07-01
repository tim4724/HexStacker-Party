import SpriteKit
import HexStackerKit

/// A focusable text button for the lobby / results / pause menus, navigable with
/// the Siri Remote (d-pad to move focus, Select to activate). Mirrors the web
/// `.btn-primary` / `.btn-secondary`: a 12px rounded rect (var(--radius-md)),
/// primary = top→bottom gradient of the tint, secondary = card fill + rim. The
/// focused state adds a bright ring + slight scale (the tvOS focus convention).
final class MenuButton: SKNode, Focusable {
    let action: () -> Void
    let enabled: Bool

    private let primary: Bool
    private let tint: UIColor
    private let secondaryTint: Bool
    private let ring = SKShapeNode()
    private let label = SKLabelNode()
    private let labelText: String
    private let labelSize: CGFloat

    /// `secondaryTint` gives a secondary button a `tint`-colored outline + label
    /// (instead of the neutral border/text), tying it to an identity color while
    /// staying visually distinct from a filled primary button.
    init(text: String, width: CGFloat, height: CGFloat, primary: Bool,
         tint: UIColor, secondaryTint: Bool = false, enabled: Bool = true, action: @escaping () -> Void) {
        self.action = action
        self.enabled = enabled
        self.primary = primary
        self.tint = tint
        self.secondaryTint = secondaryTint
        self.labelText = text
        self.labelSize = height * 0.36
        super.init()

        let radius: CGFloat = 12   // var(--radius-md)
        let top: UIColor, bottom: UIColor
        if enabled && primary {
            top = tint; bottom = Self.scaled(tint, 0.82)
        } else {
            top = SKTheme.bgCard; bottom = SKTheme.bgCard
        }
        let fill = SKSpriteNode(texture: Self.bakeFill(width: width, height: height, radius: radius,
                                                       top: top, bottom: bottom))
        fill.size = CGSize(width: width, height: height)
        fill.zPosition = 0
        addChild(fill)

        ring.path = UIBezierPath(roundedRect: CGRect(x: -width / 2, y: -height / 2, width: width, height: height),
                                 cornerRadius: radius).cgPath
        ring.fillColor = .clear
        ring.isAntialiased = true
        ring.zPosition = 1
        addChild(ring)

        label.verticalAlignmentMode = .center
        label.horizontalAlignmentMode = .center
        label.zPosition = 2
        addChild(label)

        setFocused(false)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    func activate() { action() }

    func setFocused(_ focused: Bool) {
        let secondaryText: UIColor = secondaryTint ? tint : SKTheme.textPrimary()
        let textColor: UIColor = !enabled ? SKTheme.textSecondary
            : (primary ? SKTheme.btnPrimaryText : secondaryText)
        label.setStyledText(labelText, font: AppFont.name, size: labelSize, color: textColor, tracking: 0.08)

        guard enabled else {
            ring.strokeColor = SKTheme.border; ring.lineWidth = 1
            setScale(1.0); return
        }
        if primary {
            ring.strokeColor = focused ? .white : .clear
            ring.lineWidth = focused ? 4 : 0
        } else {
            // Tinted secondary: a host-colored outline (2px) so the color reads;
            // neutral secondary keeps the 1px strong border. Focus overrides to white.
            ring.strokeColor = focused ? .white : (secondaryTint ? tint : SKTheme.borderStrong)
            ring.lineWidth = focused ? 4 : (secondaryTint ? 2 : 1)
        }
        setScale(focused ? 1.06 : 1.0)
    }

    private static func scaled(_ c: UIColor, _ f: CGFloat) -> UIColor {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        c.getRed(&r, green: &g, blue: &b, alpha: &a)
        return UIColor(red: r * f, green: g * f, blue: b * f, alpha: a)
    }

    private static func bakeFill(width: CGFloat, height: CGFloat, radius: CGFloat,
                                 top: UIColor, bottom: UIColor) -> SKTexture {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: width, height: height))
        let image = renderer.image { rctx in
            let ctx = rctx.cgContext
            let rect = CGRect(x: 0, y: 0, width: width, height: height)
            ctx.addPath(UIBezierPath(roundedRect: rect, cornerRadius: radius).cgPath)
            ctx.clip()
            if let grad = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(),
                                     colors: [top.cgColor, bottom.cgColor] as CFArray, locations: [0, 1]) {
                ctx.drawLinearGradient(grad, start: .zero, end: CGPoint(x: 0, y: height), options: [])
            }
        }
        return SKTexture(image: image)
    }
}
