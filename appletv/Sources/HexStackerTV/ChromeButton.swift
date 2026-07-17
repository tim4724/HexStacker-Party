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
    var minWidth: CGFloat? = nil   // web overlay CTAs: min-width over the content hug
    let height: CGFloat
    var hPad: CGFloat? = nil   // content-hugging pills override the default pad
    let action: () -> Void

    var body: some View {
        // A disabled button stays FOCUSABLE (action gated to a no-op) so
        // the cursor never vanishes while a screen waits on state.
        Button(action: enabled ? action : {}) {
            ChromeButtonLabel(text: text, primary: primary, enabled: enabled,
                              width: width, minWidth: minWidth, height: height, hPad: hPad)
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
                              width: width, minWidth: nil, height: height, hPad: hPad)
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
    let minWidth: CGFloat?
    let height: CGFloat
    let hPad: CGFloat?

    var body: some View {
        // 0.32 = web CTA font clamp(1.1rem, 2.4vh, 1.7rem) over the shared
        // .btn height max(48, 7.5vh): 2.4 / 7.5.
        Text(text)
            .styled(font: AppFont.brandBold, size: height * 0.32,
                    color: !enabled ? UITheme.textSecondary
                        : (primary ? UITheme.btnPrimaryText : UITheme.textPrimary()),
                    tracking: 0.08)
            .lineLimit(1)
            .padding(.horizontal, hPad ?? height * 0.6)
            .frame(minWidth: minWidth)
            .frame(width: width, height: height)
    }
}

/// The shared focus/press animation feel, used by every focusable chrome
/// control (ChromeButton, the lobby ⓘ, the music switch, the license rows) so
/// the whole remote UI moves as one.
enum PressFeel {
    /// Slightly springy, tracking the system focus engine's own feel.
    static let focus = Animation.spring(response: 0.28, dampingFraction: 0.75)
    /// Fast plain ease so the click lands instantly.
    static let press = Animation.easeOut(duration: 0.1)
}

private struct ChromeButtonStyle: ButtonStyle {
    let primary: Bool
    let tint: Color
    let enabled: Bool
    @Environment(\.isFocused) private var focused

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .modifier(ChromeButtonChrome(primary: primary, tint: tint,
                                         enabled: enabled, focused: focused,
                                         // Disabled pills stay focusable but must not
                                         // sink (web: no :active on :disabled).
                                         pressed: configuration.isPressed && enabled))
    }
}

/// The shared fill + focus/press treatment (web .btn-primary/.btn-secondary A2).
/// Rest carries the web --shadow-sm; focus lifts (white ring, 1.06 scale, deeper
/// drop shadow, the tvOS focus convention); press sinks the pill back to rest
/// size and drops the shadow (web .btn:active translateY(1px) + box-shadow:
/// none, scaled up to 10-foot visibility).
private struct ChromeButtonChrome: ViewModifier {
    let primary: Bool
    let tint: Color
    let enabled: Bool
    let focused: Bool
    let pressed: Bool

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: 16)   // var(--radius-btn)
        content
            .background(
                // Shadow on the fill shape, not the composed content: a plain
                // .shadow after .background would also shadow the label glyphs.
                shape.fill(fill)
                    .shadow(color: .black.opacity(shadowAlpha),
                            radius: focused ? 12 : 4, x: 0, y: focused ? 8 : 2)
            )
            .overlay(
                // Both variants are borderless at rest (A2); focus adds the
                // white ring, on the quiet disabled fill too (the cursor must
                // stay visible while the pill waits for players).
                shape.stroke(focused ? Color.white : .clear, lineWidth: 4)
            )
            .scaleEffect(pressed ? 1.0 : (focused ? 1.06 : 1.0))
            .animation(PressFeel.focus, value: focused)
            .animation(PressFeel.press, value: pressed)
    }

    /// web --shadow-sm at rest, grown into the focus lift; gone while pressed
    /// (web .btn:active) or disabled (web .btn-primary:disabled).
    private var shadowAlpha: CGFloat {
        if !enabled || pressed { return 0 }
        return focused ? 0.4 : 0.32
    }

    private var fill: AnyShapeStyle {
        if enabled && primary {
            AnyShapeStyle(LinearGradient(colors: [tint, tint.scaled(0.82)],
                                         startPoint: .top, endPoint: .bottom))
        } else if enabled {
            AnyShapeStyle(UITheme.bgCardSoft)    // web .btn-secondary A2: borderless soft-card fill
        } else {
            AnyShapeStyle(UITheme.bgCard)        // web .btn-primary:disabled: quiet card, no tint
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
