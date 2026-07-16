import SwiftUI

/// Full-screen overlay for the DISPLAY's own relay link (web `#reconnect-overlay`,
/// SpriteKit `showConnectionOverlay`). While auto-retrying it reads RECONNECTING /
/// "Attempt N of M"; once the client gives up it reads DISCONNECTED with a
/// focusable RECONNECT. When showReconnect is false (a terminal slot-0 eviction:
/// another display took over the room) it is heading-only, mirroring the web
/// dropping the reconnect button. All copy is the web i18n source (no TV-only strings).
struct ConnectionOverlayView: View {
    let disconnected: Bool
    let showReconnect: Bool
    let attempt: Int
    let maxAttempts: Int
    let hostColorSlot: Int?
    let vp: Vp
    let onReconnect: () -> Void

    // Nothing else is focusable in the gave-up state, so RECONNECT must grab
    // focus when it appears or the D-pad can't reach it (Android
    // LaunchedEffect(disconnected, showReconnect) parity).
    @FocusState private var reconnectFocused: Bool
    private var grabsFocus: Bool { disconnected && showReconnect }

    var body: some View {
        let btnH = vp.actionButtonH

        ZStack {
            UITheme.overlayBg.ignoresSafeArea()
            // The centered group keeps the heading+button symmetric on the board
            // (SpriteKit heading +0.05h / button -0.05h); reconnecting sits the
            // status a hair below the heading.
            VStack(spacing: disconnected ? vp.h * 0.05 : vp.h * 0.04) {
                // One heading scale for every full-screen overlay state (web A2:
                // #pause-overlay h1, #reconnect-overlay h1 share clamp(1.6rem,4vh,3.5rem)).
                Text(disconnected ? tr("disconnected") : tr("reconnecting"))
                    .styled(font: AppFont.brandExtraBold, size: vp.vh(25.6, 4, 56),
                            color: UITheme.textPrimary(), tracking: 0.15)

                if !disconnected {
                    // Web shows the status only while reconnecting: "Attempt N of M"
                    // (clamp N to M). Every .reconnecting emission is preceded by
                    // onReconnecting, so the count is always ≥ 1 here.
                    // web .game-overlay__status clamp(1.2rem,2.4vh,1.6rem).
                    Text(tr("attempt_n_of_m", min(attempt, maxAttempts), maxAttempts))
                        .styled(font: AppFont.brandBold, size: vp.vh(19.2, 2.4, 25.6),
                                color: UITheme.textSecondary, tracking: 0.08)
                }

                if grabsFocus {
                    // Host-tinted like every web primary CTA (#reconnect-btn reads
                    // --player-color); web overlay CTAs share min-width
                    // clamp(260px, 34vh, 420px) on top of the content hug.
                    ChromeButton(text: tr("reconnect"), primary: true,
                                 tint: UITheme.hostTint(hostColorSlot),
                                 minWidth: vp.vh(260, 34, 420),
                                 height: btnH, action: onReconnect)
                        .focused($reconnectFocused)
                }
            }
        }
        .onChange(of: grabsFocus, initial: true) { _, grab in
            if grab { reconnectFocused = true }
        }
    }
}
