import SwiftUI

/// The shared TV button (web .btn-primary / .btn-secondary, A2): a 16pt
/// rounded rect, primary = top→bottom gradient of the tint, secondary =
/// borderless soft-card fill, disabled = quiet card surface. Focus adds the
/// white ring + slight scale (the tvOS focus convention). Replaces the
/// SpriteKit MenuButton; the tint is LIVE state, so a host handoff recolors
/// primaries by plain re-render (web --player-color parity).
struct ChromeButton: View {
    let text: String
    let primary: Bool
    let tint: Color
    var enabled = true
    var width: CGFloat? = nil
    let height: CGFloat
    var hPad: CGFloat? = nil   // content-hugging pills override the default pad
    // nil = a native focus-engine Button (overlays). Non-nil = a manually
    // focused rendering with no engine participation: the lobby drives its
    // own two-item menu, because the engine skips entrance-transparent views
    // and strands the live lobby without a cursor.
    var manualFocus: Bool? = nil
    let action: () -> Void

    var body: some View {
        if let manualFocus {
            label
                .modifier(ChromeButtonChrome(primary: primary, tint: tint,
                                             enabled: enabled, focused: manualFocus))
        } else {
            // A disabled button stays FOCUSABLE (action gated to a no-op) so
            // the cursor never vanishes while a screen waits on state.
            Button(action: enabled ? action : {}) { label }
                .buttonStyle(ChromeButtonStyle(primary: primary, tint: tint, enabled: enabled))
        }
    }

    private var label: some View {
        Text(text)
            .styled(font: AppFont.brandBold, size: height * 0.36,
                    color: !enabled ? UITheme.textSecondary
                        : (primary ? UITheme.btnPrimaryText : UITheme.textPrimary()),
                    tracking: 0.08)
            .lineLimit(1)
            .padding(.horizontal, hPad ?? height * 0.6)
            .frame(width: width, height: height)
    }
}

private struct ChromeButtonStyle: ButtonStyle {
    let primary: Bool
    let tint: Color
    let enabled: Bool
    @Environment(\.isFocused) private var focused

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .modifier(ChromeButtonChrome(primary: primary, tint: tint,
                                         enabled: enabled, focused: focused))
    }
}

/// The shared fill + focus ring treatment (web .btn-primary/.btn-secondary
/// A2), applied identically whether focus comes from the engine or the
/// lobby's manual menu.
private struct ChromeButtonChrome: ViewModifier {
    let primary: Bool
    let tint: Color
    let enabled: Bool
    let focused: Bool

    func body(content: Content) -> some View {
        content
            .background(fill)
            .clipShape(RoundedRectangle(cornerRadius: 16))   // var(--radius-btn)
            .overlay(
                // Both variants are borderless at rest (A2); focus adds the
                // white ring, on the quiet disabled fill too (the cursor must
                // stay visible while the pill waits for players).
                RoundedRectangle(cornerRadius: 16)
                    .stroke(focused ? Color.white : .clear, lineWidth: 4)
            )
            .scaleEffect(focused ? 1.06 : 1.0)
            .animation(.easeOut(duration: 0.15), value: focused)
    }

    @ViewBuilder private var fill: some View {
        if enabled && primary {
            LinearGradient(colors: [tint, tint.scaled(0.82)],
                           startPoint: .top, endPoint: .bottom)
        } else if enabled {
            UITheme.bgCardSoft    // web .btn-secondary A2: borderless soft-card fill
        } else {
            UITheme.bgCard        // web .btn-primary:disabled: quiet card, no tint
        }
    }
}

extension Color {
    /// Channel-scaled shade (the old MenuButton gradient bottom: tint × 0.82).
    func scaled(_ f: CGFloat) -> Color {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        UIColor(self).getRed(&r, green: &g, blue: &b, alpha: &a)
        return Color(red: r * f, green: g * f, blue: b * f, opacity: a)
    }
}
