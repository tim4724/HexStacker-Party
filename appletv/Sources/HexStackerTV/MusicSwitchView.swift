import SwiftUI

/// The host's "Game Music" on/off control (the display-side mute), surfaced in
/// the pause overlay as a content-hugging settings row: label beside the switch
/// with a snug focus frame around just that pair (web `.settings-switch`). A
/// frame at the button-pair width reads as a stray empty panel (Android parity).
/// Replaces the SpriteKit MusicSwitch. ON = music playing.
struct MusicSwitchView: View {
    let isOn: Bool
    /// ON track color (web --player-color); the accentSecondary fallback is
    /// applied by the caller — the SpriteKit switch falls back to accentSecondary
    /// while the CTAs fall back to accentPrimary.
    let tint: Color
    let rowHeight: CGFloat
    /// Gallery seed: a frozen capture can't drive the live focus engine, so the
    /// pause-music shot forces the focused visual directly (Android
    /// focusedForShot parity).
    var focusedForShot: Bool = false
    let onToggle: () -> Void

    var body: some View {
        Button(action: onToggle) { pair }
            .buttonStyle(MusicSwitchStyle(rowHeight: rowHeight, focusedForShot: focusedForShot))
    }

    private var pair: some View {
        // web .settings-switch geometry: 52x30 track, 24px thumb, 3px inset.
        let trackH = rowHeight * 0.46
        let trackW = trackH * (52.0 / 30.0)
        let knobD = trackH * (24.0 / 30.0)
        let margin = trackH * (3.0 / 30.0)
        // Android: label↔switch gap 0.75×rowHeight.
        return HStack(spacing: rowHeight * 0.75) {
            Text(tr("settings_game_music"))   // web settings label: not uppercased
                .styled(font: AppFont.brandSemibold, size: rowHeight * 0.40,
                        color: UITheme.textPrimary(), tracking: 0.05)
            ZStack(alignment: .leading) {
                // web ON = --player-color, OFF = rgba(255,255,255,.12).
                Capsule()
                    .fill(isOn ? tint : Color.white.opacity(0.12))
                    .frame(width: trackW, height: trackH)
                Circle()
                    .fill(Color.white)
                    .frame(width: knobD, height: knobD)
                    .offset(x: isOn ? trackW - margin - knobD : margin)
                    // Brief slide on toggle (Android animateDpAsState parity).
                    .animation(.easeInOut(duration: 0.15), value: isOn)
            }
        }
    }
}

/// Content-hugging focus frame around the label+switch pair, matching the
/// ChromeButton focus treatment: white 4pt ring, faint fill, slight
/// scale (the tvOS focus convention).
private struct MusicSwitchStyle: ButtonStyle {
    let rowHeight: CGFloat
    let focusedForShot: Bool
    @Environment(\.isFocused) private var isFocused

    func makeBody(configuration: Configuration) -> some View {
        let focused = isFocused || focusedForShot
        return configuration.label
            .padding(.horizontal, rowHeight * 0.5)   // Android: frame side padding 0.5×rowHeight
            .frame(height: rowHeight)
            .background(focused ? Color.white.opacity(0.06) : .clear)
            .clipShape(RoundedRectangle(cornerRadius: 12))   // SpriteKit MusicSwitch ring radius
            .overlay(
                RoundedRectangle(cornerRadius: 12)
                    .stroke(focused ? Color.white : .clear, lineWidth: 4)
            )
            .scaleEffect(focused ? 1.03 : 1.0)
            .animation(.easeOut(duration: 0.15), value: focused)
    }
}
