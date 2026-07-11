import UIKit
import HexStackerKit

// Bridges the platform-agnostic RGB theme values (HexStackerKit) to UIKit/SpriteKit colors.

extension UIColor {
    convenience init(_ rgb: RGB, alpha: CGFloat = 1) {
        self.init(red: CGFloat(rgb.r) / 255, green: CGFloat(rgb.g) / 255, blue: CGFloat(rgb.b) / 255, alpha: alpha)
    }
}

enum SKTheme {
    static func player(slot: Int) -> UIColor { UIColor(Theme.playerColor(slot: slot)) }

    static let bgPrimary = UIColor(Theme.bgPrimary)
    static let bgSecondary = UIColor(Theme.bgSecondary)
    static let bgBoard = UIColor(Theme.bgBoard)

    // Lobby / results UI tokens, mirrored from theme.css.
    static let bgCard = UIColor(RGB(0x2A, 0x25, 0x40))           // --bg-card
    static let bgCardSoft = UIColor(RGB(0x34, 0x2E, 0x4D))       // --bg-card-soft
    static let accentPrimary = UIColor(RGB(0xFF, 0x6B, 0x6B))    // --accent-primary
    static let accentSecondary = UIColor(RGB(0xFF, 0x8C, 0x42))  // --accent-secondary
    static let btnPrimaryText = UIColor(RGB(0x1E, 0x1A, 0x2B))   // dark text on tinted CTAs
    static let danger = UIColor(RGB(0xFF, 0x44, 0x44))           // --danger / THEME.color.ko.text

    /// Recessed socket fill — bgBoard (rgb 21,18,31) at alpha, the shared
    /// recipe for empty player slots, level pills, and round utility buttons.
    static func socket(_ a: CGFloat) -> UIColor { UIColor(Theme.bgBoard, alpha: a) }

    /// Warm-paper hairline (rgba(255,248,236,X)) for socket rims and ring strokes.
    static func hairline(_ a: CGFloat) -> UIColor { UIColor(Theme.hairline, alpha: a) }

    /// Tonal card surface — the canvas (srgb) approximation of the A2 recipe
    /// color-mix(in oklab, <color> 20%, var(--bg-card)); nil color = plain card.
    static func tonalCard(_ color: UIColor?, mix: CGFloat = 0.2) -> UIColor {
        guard let color else { return bgCard }
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        color.getRed(&r, green: &g, blue: &b, alpha: &a)
        let card = (r: CGFloat(0x2A) / 255, g: CGFloat(0x25) / 255, b: CGFloat(0x40) / 255)
        return UIColor(red: r * mix + card.r * (1 - mix),
                       green: g * mix + card.g * (1 - mix),
                       blue: b * mix + card.b * (1 - mix), alpha: 1)
    }

    // Cream text ramp (#F7F1E8 == 247,241,232) at theme opacities.
    static func textPrimary(_ a: CGFloat = 1) -> UIColor { UIColor(red: 247/255, green: 241/255, blue: 232/255, alpha: a) }
    static let textSecondary = textPrimary(0.65)                  // --text-secondary
    static let textFaint = textPrimary(0.4)                       // --text-faint

    // Off-white border ramp (#FFF8EC == 255,248,236).
    static func offWhite(_ a: CGFloat) -> UIColor { UIColor(red: 255/255, green: 248/255, blue: 236/255, alpha: a) }
    static let border = offWhite(0.08)                            // --border
}
