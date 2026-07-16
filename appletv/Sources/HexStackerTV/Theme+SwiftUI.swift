import SwiftUI

// SwiftUI Color mirror of SKTheme (which bridges the platform-agnostic kit
// Theme). One source: every token wraps its UIColor twin, so the SpriteKit
// board layer and the SwiftUI chrome can never drift apart.

enum UITheme {
    static func player(slot: Int) -> Color { Color(SKTheme.player(slot: slot)) }
    /// Host CTA tint: the host's identity color, accent-red fallback while no
    /// host is seated (web --player-color / --accent-primary).
    static func hostTint(_ slot: Int?) -> Color { slot.map { player(slot: $0) } ?? accentPrimary }

    static let bgPrimary = Color(SKTheme.bgPrimary)
    static let bgCard = Color(SKTheme.bgCard)
    static let bgCardSoft = Color(SKTheme.bgCardSoft)
    static let accentPrimary = Color(SKTheme.accentPrimary)
    static let accentSecondary = Color(SKTheme.accentSecondary)
    static let btnPrimaryText = Color(SKTheme.btnPrimaryText)
    static let border = Color(SKTheme.border)

    /// Flat plum scrim behind every game overlay (web --overlay-bg:
    /// bg-primary at 0.88 — the A2 flat rule, no blur).
    static let overlayBg = Color(SKTheme.bgPrimary).opacity(0.88)

    static func socket(_ a: CGFloat) -> Color { Color(SKTheme.socket(a)) }
    static func hairline(_ a: CGFloat) -> Color { Color(SKTheme.hairline(a)) }
    static func tonalCard(_ color: Color?, mix: CGFloat = 0.2) -> Color {
        Color(SKTheme.tonalCard(color.map { UIColor($0) }, mix: mix))
    }

    static func textPrimary(_ a: CGFloat = 1) -> Color { Color(SKTheme.textPrimary(a)) }
    static let textSecondary = Color(SKTheme.textSecondary)
    static let textFaint = Color(SKTheme.textFaint)
}

// Brand faces at the AppFont-resolved PostScript names, with the em-based
// letter-spacing the SpriteKit chrome applied via setStyledText (CSS
// letter-spacing parity): .kerning(size * tracking).
extension Text {
    func styled(font: String, size: CGFloat, color: Color, tracking: CGFloat = 0) -> Text {
        self.font(.custom(font, size: size))
            .foregroundColor(color)
            .kerning(size * tracking)
    }
}
