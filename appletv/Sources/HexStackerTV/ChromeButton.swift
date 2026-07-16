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
    let action: () -> Void

    var body: some View {
        // A disabled button stays FOCUSABLE (action gated to a no-op) so
        // the cursor never vanishes while a screen waits on state.
        Button(action: enabled ? action : {}) {
            ChromeButtonLabel(text: text, primary: primary, enabled: enabled,
                              width: width, height: height, hPad: hPad)
        }
        .buttonStyle(ChromeButtonStyle(primary: primary, tint: tint, enabled: enabled))
    }
}

/// A ChromeButton that pushes `value` on the enclosing NavigationStack instead
/// of running an action: same skin, but the push/pop (and the focus handoff
/// across it) belongs to the framework.
struct ChromeLink<V: Hashable>: View {
    let text: String
    let primary: Bool
    let tint: Color
    var width: CGFloat? = nil
    let height: CGFloat
    var hPad: CGFloat? = nil
    let value: V

    var body: some View {
        NavigationLink(value: value) {
            ChromeButtonLabel(text: text, primary: primary, enabled: true,
                              width: width, height: height, hPad: hPad)
        }
        .buttonStyle(ChromeButtonStyle(primary: primary, tint: tint, enabled: true))
    }
}

/// The shared pill face (text, metrics, color), worn by the button and the link.
private struct ChromeButtonLabel: View {
    let text: String
    let primary: Bool
    let enabled: Bool
    let width: CGFloat?
    let height: CGFloat
    let hPad: CGFloat?

    var body: some View {
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

/// The shared fill + focus ring treatment (web .btn-primary/.btn-secondary A2).
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
