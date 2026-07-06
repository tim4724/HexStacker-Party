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
    static let accentPrimary = UIColor(RGB(0xFF, 0x6B, 0x6B))    // --accent-primary
    static let accentSecondary = UIColor(RGB(0xFF, 0x8C, 0x42))  // --accent-secondary
    static let btnPrimaryText = UIColor(RGB(0x1E, 0x1A, 0x2B))   // dark text on tinted CTAs

    // Cream text ramp (#F7F1E8 == 247,241,232) at theme opacities.
    static func textPrimary(_ a: CGFloat = 1) -> UIColor { UIColor(red: 247/255, green: 241/255, blue: 232/255, alpha: a) }
    static let textSecondary = textPrimary(0.65)                  // --text-secondary
    static let textFaint = textPrimary(0.4)                       // --text-faint

    // Off-white border ramp (#FFF8EC == 255,248,236).
    static func offWhite(_ a: CGFloat) -> UIColor { UIColor(red: 255/255, green: 248/255, blue: 236/255, alpha: a) }
    static let border = offWhite(0.08)                            // --border
    static let borderStrong = offWhite(0.16)                      // --border-strong
    static let glass = offWhite(0.06)                             // --bg-glass
}
