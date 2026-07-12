import SwiftUI

/// Pause overlay (web `#pause-overlay`, SpriteKit `setPaused`): "PAUSED" over a
/// compact Game Music switch row and a Continue / New Game button pair. The music
/// row is the TV addition (the display has no toolbar mute on the couch).
/// Default focus = CONTINUE; D-pad Up from the buttons reaches the music switch.
struct PauseOverlayView: View {
    let hostColorSlot: Int?
    let musicOn: Bool
    let vp: Vp
    let focusMusicForShot: Bool
    let onToggleMusic: () -> Void
    let onContinue: () -> Void
    let onNewGame: () -> Void

    private enum Field { case music, cont, newGame }
    @FocusState private var focus: Field?

    var body: some View {
        // setPaused metrics: btn height max(48, 7.5vh), width max(18vw, h·4.5),
        // gap 3vw; three rows evenly spaced by 13% of the play height.
        let btnH = vp.actionButtonH
        let btnW = max(vp.w * 0.18, btnH * 4.5)
        let gap = vp.w * 0.03
        let rowSpacing = vp.h * 0.13

        ZStack {
            UITheme.overlayBg.ignoresSafeArea()

            // Three rows on evenly spaced CENTERS around the middle (PAUSED /
            // music / buttons), like the original setPaused laid them out; a
            // spacing-based stack would inflate the gaps by the rows' heights.
            // web #pause-overlay h1 clamp(1.6rem,4vh,3.5rem).
            Text(tr("paused"))
                .styled(font: AppFont.brandExtraBold, size: vp.vh(25.6, 4, 56),
                        color: UITheme.textPrimary(), tracking: 0.15)
                .offset(y: -rowSpacing)

            // ON tint = host color, accentSecondary fallback (the SpriteKit
            // switch falls back to accentSecondary; the CTAs to accentPrimary).
            MusicSwitchView(isOn: musicOn,
                            tint: hostColorSlot.map { UITheme.player(slot: $0) } ?? UITheme.accentSecondary,
                            rowHeight: btnH,
                            focusedForShot: focusMusicForShot,
                            onToggle: onToggleMusic)
                .focused($focus, equals: .music)

            HStack(spacing: gap) {
                // Continue is the sole filled host CTA (web --player-color).
                ChromeButton(text: trUpper("continue_btn"), primary: true,
                             tint: UITheme.hostTint(hostColorSlot),
                             width: btnW, height: btnH, action: onContinue)
                    .focused($focus, equals: .cont)
                // Neutral secondary (web .btn-secondary): tint is unused by a
                // secondary fill, so no host color leaks onto New Game.
                ChromeButton(text: trUpper("new_game"), primary: false,
                             tint: UITheme.accentPrimary,
                             width: btnW, height: btnH, action: onNewGame)
                    .focused($focus, equals: .newGame)
            }
            .offset(y: rowSpacing)
        }
        // Default focus = Continue; the pause-music shot seeds the switch instead.
        .defaultFocus($focus, focusMusicForShot ? .music : .cont)
    }
}
