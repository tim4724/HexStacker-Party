import SwiftUI
import UIKit
import HexStackerKit

/// Results screen (web `renderResults` / `#results-screen`, Android
/// `ResultsScreen`). Three bands centred on the falling-piece backdrop (the
/// BoardScene shows it over the frozen boards on results, so this view paints
/// no scrim): the brand lockup, the standings table, PLAY AGAIN + NEW GAME. The
/// triad badge sits in the corner like the lobby's, and a soft radial glow in
/// the winner's colour tints the backdrop. The PLAY AGAIN primary CTA is
/// host-tinted (web `applyHostTint`). No anti-misclick gate on the TV (a couch
/// remote, not a phone): the buttons are live and focusable immediately.
///
/// The whole-screen fade is the parent's job: DisplayChromeView presents this via
/// `.transition(.opacity)`, so this view only stages its own row + button entrance.
struct ResultsView: View {
    let results: [MatchResult]
    let hostColorSlot: Int?
    let vp: Vp
    let onPlayAgain: () -> Void
    let onNewGame: () -> Void

    private enum Field { case playAgain, newGame }
    @FocusState private var focus: Field?

    /// Buttons fade in with the list (web .result-actions), matching the 0.4s row
    /// stagger duration with no per-row delay. Reduce Motion shows them settled
    /// (web results.css forces this gate open under prefers-reduced-motion).
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var buttonsShown = false

    /// Winner glow color: the lowest-rank player's identity color at 0.08 (web
    /// --winner-glow), gold #FFD700 at 0.06 as the no-winner fallback (Android
    /// parity for the no-winner-color case).
    private static func glow(for sorted: [MatchResult]) -> Color {
        if let slot = sorted.first?.colorIndex {
            return UITheme.player(slot: slot).opacity(0.08)
        }
        return Color(red: 1, green: 0.843, blue: 0).opacity(0.06)
    }

    /// 180px tile of grayscale noise (the web bakes the equivalent from an SVG
    /// feTurbulence data URI). Seeded xorshift so gallery captures stay
    /// byte-stable across launches.
    private static let noiseTile: UIImage = {
        let side = 180
        var state: UInt64 = 0x9E3779B97F4A7C15
        var pixels = [UInt8](repeating: 0, count: side * side)
        for i in pixels.indices {
            state ^= state << 13
            state ^= state >> 7
            state ^= state << 17
            pixels[i] = UInt8(truncatingIfNeeded: state)
        }
        let provider = CGDataProvider(data: Data(pixels) as CFData)!
        let image = CGImage(width: side, height: side,
                            bitsPerComponent: 8, bitsPerPixel: 8, bytesPerRow: side,
                            space: CGColorSpaceCreateDeviceGray(),
                            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue),
                            provider: provider, decode: nil,
                            shouldInterpolate: false, intent: .defaultIntent)!
        return UIImage(cgImage: image)
    }()

    var body: some View {
        // Sort once per render (nil rank = late joiners, sorted last), then derive
        // the glow, solo flag and rows from it rather than re-sorting per access.
        let sorted = results.sorted { ($0.rank ?? 999) < ($1.rank ?? 999) }
        let glowColor = Self.glow(for: sorted)
        let solo = sorted.count == 1
        let W = vp.w, H = vp.h
        let margin = H * 0.05   // the lobby's edge margin, for the corner badge

        // #results-table: rows share the ~53vh the title, header and buttons
        // leave, capped at 13.3vh (and 11.3vw) so 1-4 players don't balloon;
        // tighter gap for 5+. The LINES / LEVEL columns (statW wide, statGap
        // apart and inset from the right edge) line the header up with the values.
        let n = CGFloat(max(sorted.count, 1))
        let rowGap = H * (sorted.count > 4 ? 0.011 : 0.019)
        let rowH = min(H * 0.133, W * 0.113, (H * 0.53 - (n - 1) * rowGap) / n)
        let rowW = min(W * 0.9, H * 1.05)
        let statW = max(H * 0.11, rowH * 1.4)
        let statGap = rowH * 0.2
        let headSize = max(12, H * 0.0167, rowH * 0.19)
        // #results-screen gap clamp(1.5rem, 7.8vh, 5.5rem) between the bands.
        let bandGap = vp.vh(24, 7.8, 88)
        // The lobby's wordmark, at the web h1 clamp(1.6rem, 6vmin, 4.4rem).
        let titleSize = max(25.6, min(vp.vmin * 0.06, 70.4))
        let titleImage = TitleImageCache.image(mainSize: titleSize)

        // Action-button metrics.
        let btnH = vp.actionButtonH
        let btnW = max(W * 0.20, btnH * 4.5)
        let btnGap = W * 0.03

        ZStack(alignment: .top) {
            AmbientVignette(vp: vp)
            // The single soft winner radial (web --winner-glow at 50% 30%,
            // radius 0.6x the farthest-corner distance).
            Rectangle()
                .fill(RadialGradient(
                    colors: [glowColor, .clear],
                    center: UnitPoint(x: 0.5, y: 0.3),
                    startRadius: 0,
                    endRadius: 0.6 * hypot(W * 0.5, H * 0.7)))
                .ignoresSafeArea()
            // Anti-banding dither (web #results-screen::before): the low-alpha
            // radial above bands visibly on 8-bit panels; tiled grayscale noise
            // at 0.05 with overlay blending breaks the bands perceptually.
            Image(uiImage: Self.noiseTile)
                .resizable(resizingMode: .tile)
                .opacity(0.05)
                .blendMode(.overlay)
                .allowsHitTesting(false)
                .ignoresSafeArea()

            VStack(spacing: bandGap) {
                Image(uiImage: titleImage)
                    // Cancel TitleTexture's baked glyph headroom (0.3em a side)
                    // so the band gap measures from the lockup's line boxes,
                    // like the web h1.
                    .padding(.vertical, -titleSize * 0.3)

                VStack(spacing: H * 0.012) {
                    // .results-head: the column labels, each centred over its
                    // values (the 0.2em lead balances the trailing tracking).
                    HStack(spacing: statGap) {
                        ForEach(["lines", "level_heading"], id: \.self) { key in
                            Text(trUpper(key))
                                .styled(font: AppFont.brandBold, size: headSize,
                                        color: UITheme.textSecondary, tracking: 0.2)
                                .padding(.leading, headSize * 0.2)
                                .frame(width: statW)
                        }
                    }
                    .padding(.trailing, statGap)
                    .frame(width: rowW, alignment: .trailing)

                    VStack(spacing: rowGap) {
                        ForEach(Array(sorted.enumerated()), id: \.element.playerId) { i, res in
                            // Keyed by playerId like the lobby grid: late joiners append
                            // at runtime, and the id keeps each row's entrance with its
                            // player rather than restaging the whole list.
                            ResultRow(res: res, index: i, solo: solo, rowW: rowW, rowH: rowH,
                                      statW: statW, statGap: statGap, vp: vp)
                        }
                    }
                }

                HStack(spacing: btnGap) {
                    // The primary CTA reads the host color (web applyHostTint); the
                    // winner only tints the background glow, not the button.
                    ChromeButton(text: trUpper("play_again"), primary: true,
                                 tint: UITheme.hostTint(hostColorSlot),
                                 width: btnW, height: btnH, action: onPlayAgain)
                        .focused($focus, equals: .playAgain)
                    ChromeButton(text: trUpper("new_game"), primary: false,
                                 tint: UITheme.hostTint(hostColorSlot),
                                 width: btnW, height: btnH, action: onNewGame)
                        .focused($focus, equals: .newGame)
                }
                .opacity(reduceMotion || buttonsShown ? 1 : 0)
                .defaultFocus($focus, .playAgain)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            // Triad corner badge, placed and faded in exactly as the lobby's.
            let badge = TitleImageCache.mark(width: max(40, min(vp.vmin * 0.064, 80)))
            Image(uiImage: badge)
                .position(x: margin * 0.4 + badge.size.width / 2,
                          y: margin * 0.4 + badge.size.height / 2)
                .modifier(Entrance(dy: 0, delay: 0.3, duration: 0.6))
        }
        .onAppear {
            withAnimation(.easeOut(duration: 0.4)) { buttonsShown = true }
            // Imperative seed alongside .defaultFocus: the buttons insert at
            // opacity 0 (the entrance fade), and the focus engine skips
            // entrance-transparent views. Assigning FocusState directly works
            // even while transparent (LobbyView and ConnectionOverlayView do
            // the same).
            focus = .playAgain
        }
    }
}

/// One ranked row (web `.result-row`): rank | name | lines + level values on the
/// lobby player card's tonal fill, flat (no shadow). Everything scales off the
/// row height. Late joiners get the recessed socket treatment (web
/// `.result-row--joining`: socket fill, faint hairline, dimmed) and a "New
/// player" line across both columns.
private struct ResultRow: View {
    let res: MatchResult
    let index: Int
    let solo: Bool
    let rowW: CGFloat
    let rowH: CGFloat
    let statW: CGFloat
    let statGap: CGFloat
    let vp: Vp

    /// Stagger entrance: fade + 10pt upward drift, delay 0.2 + 0.08*index s.
    /// Reduce Motion renders the row settled (decorative entrance).
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shown = false

    private var playerColor: Color? { res.colorIndex.map { UITheme.player(slot: $0) } }
    private var baseOpacity: CGFloat { res.newPlayer ? 0.75 : 1 }   // .result-row--joining dim

    var body: some View {
        // web .result-row font-size max(1rem, 2.5vh, 0.36 row), .result-stats 0.85em.
        let fontSize = max(16, vp.h * 0.025, rowH * 0.36)
        let statsSize = fontSize * 0.85

        HStack(spacing: statGap) {
            if !solo {
                // Heavy Orbitron in a min 1.1em centred column, player-colored.
                Text(res.newPlayer ? "–" : "\(res.rank ?? 0)")
                    .styled(font: AppFont.black, size: fontSize,
                            color: playerColor ?? UITheme.textSecondary, tracking: -0.02)
                    .frame(minWidth: fontSize * 1.1)
            }
            Text(res.playerName ?? tr("player"))   // web fallback for unnamed players
                .styled(font: AppFont.brandExtraBold, size: fontSize,
                        color: playerColor ?? UITheme.textPrimary(), tracking: 0.04)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
            stats(size: statsSize)
        }
        .padding(.leading, rowH * 0.25)
        .padding(.trailing, statGap)
        .frame(width: rowW, height: rowH)
        .background(card)
        .opacity(reduceMotion || shown ? baseOpacity : 0)
        .offset(y: reduceMotion || shown ? 0 : 10)
        .onAppear {
            withAnimation(.easeOut(duration: 0.4).delay(0.2 + 0.08 * Double(index))) { shown = true }
        }
    }

    // Plain values centred in the header's columns (web .result-stat); a late
    // joiner's "New player" spans both (web .result-new, 0.7em).
    @ViewBuilder private func stats(size: CGFloat) -> some View {
        if res.newPlayer {
            Text(tr("new_player"))
                .styled(font: AppFont.brandBold, size: size * 0.7, color: UITheme.textSecondary)
                .lineLimit(1)
                .frame(width: 2 * statW + statGap)
        } else {
            HStack(spacing: statGap) {
                stat(res.lines ?? 0, size: size)
                stat(res.level ?? 1, size: size)
            }
        }
    }

    private func stat(_ value: Int, size: CGFloat) -> some View {
        Text(verbatim: "\(value)")
            .styled(font: AppFont.name, size: size, color: UITheme.textPrimary())
            .monospacedDigit()
            .frame(width: statW)
    }

    @ViewBuilder private var card: some View {
        if res.newPlayer {
            RoundedRectangle(cornerRadius: 20)
                .fill(UITheme.socket(0.55))
                .overlay(RoundedRectangle(cornerRadius: 20)
                    .strokeBorder(UITheme.hairline(0.05), lineWidth: 1))
        } else {
            RoundedRectangle(cornerRadius: 20)
                .fill(UITheme.tonalCard(playerColor ?? UITheme.bgCardSoft))
        }
    }
}
