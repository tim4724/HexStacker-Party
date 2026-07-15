import SwiftUI
import HexStackerKit

/// The lobby: wordmark, triad badge, QR + join line, player grid, START.
/// Mirrors the web lobby (display.css) via the same clamp() metrics the
/// SpriteKit buildLobby carried; the falling-piece background + accent
/// vignette render in the BoardScene beneath, so this view paints no opaque
/// background. Entrance stagger replays on every (re-)entry because the view
/// leaves composition when the screen changes (web: display:none restarts the
/// one-shot CSS animations).
struct LobbyView: View {
    let data: LobbyData
    let qrPending: Bool
    let vp: Vp
    // The lobby's manual two-item focus menu (START / ⓘ). The remote drives
    // it through the responder chain (PressHostController), not the focus
    // engine: entrance-transparent views are skipped by the engine and a live
    // lobby ended up with no cursor and unreachable buttons. Activation also
    // lives there (DisplayModel.lobbySelect), so this view takes no action
    // closures.
    let focusTarget: LobbyFocus

    // Peers already seen while the lobby is up: the join pop fires only for
    // newly arriving players, not on entry or on unrelated roster churn.
    // Seeded at identity creation so the first body render (before any
    // onAppear) already knows the entry roster.
    @State private var seenPeers: Set<Int>

    init(data: LobbyData, qrPending: Bool, vp: Vp, focusTarget: LobbyFocus) {
        self.data = data
        self.qrPending = qrPending
        self.vp = vp
        self.focusTarget = focusTarget
        _seenPeers = State(initialValue: Set(data.players.map { $0.peerIndex }))
    }

    private static let qrPendingAlpha: CGFloat = 0.4

    var body: some View {
        let W = vp.w, H = vp.h
        let margin = H * 0.05

        // Title sized to ~7.5% of the play height to match the web wordmark
        // (clamp(1.6rem, 7vmin, 5rem)).
        let titleImage = TitleImageCache.image(mainSize: max(44, min(H * 0.075, 84)))
        let m = LobbyMetrics(vp: vp, titleH: titleImage.size.height,
                             playerCount: data.players.count)

        ZStack(alignment: .top) {
            // Soft accent-red radial vignette over the falling pieces (web
            // display.js draws a radial-gradient tint at 50% / 30% from the
            // top; diameter 1.15x the long screen edge).
            RadialGradient(colors: [UITheme.accentPrimary.opacity(0.06), .clear],
                           center: UnitPoint(x: 0.5, y: 0.3),
                           startRadius: 0,
                           endRadius: max(W, H) * 0.575)
                .ignoresSafeArea()

            VStack(spacing: 0) {
                Image(uiImage: titleImage)
                    .padding(.top, margin)
                    .modifier(Entrance(dy: -16, delay: 0, duration: 0.6))   // web h1 fadeDown 0.6s

                bodyBand(m: m)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .modifier(Entrance(dy: 16, delay: 0.15, duration: 0.6))  // web #lobby-body fadeUp 0.6s

                startButton()
                    .padding(.bottom, margin)
                    .modifier(Entrance(dy: 16, delay: 0.45))  // web #start-btn fadeUp
            }

            // Triad corner badge (web .brand-badge: clamp(40px, 6.4vmin, 80px),
            // top-left; fadeIn 0.6s 0.3s).
            let badge = TitleImageCache.mark(width: max(40, min(vp.vmin * 0.064, 80)))
            Image(uiImage: badge)
                .position(x: margin * 0.4 + badge.size.width / 2,
                          y: margin * 0.4 + badge.size.height / 2)
                .modifier(Entrance(dy: 0, delay: 0.3, duration: 0.6))

            // Top-right ⓘ: the entry to the About screen. Icon-only, so there
            // is no TV-only string.
            let infoD = max(40, min(H * 0.07, 64))
            InfoCircleButton(diameter: infoD, focused: focusTarget == .info)
                .position(x: W - infoD / 2 - margin * 0.2, y: infoD / 2 + margin * 0.2)
                .modifier(Entrance(dy: 0, delay: 0.6, duration: 0.5))
        }
        .onChange(of: data.players.map { $0.peerIndex }) { ids in
            seenPeers.formUnion(ids)
        }
    }

    // MARK: - Body band (QR + grid + join line)

    @ViewBuilder
    private func bodyBand(m: LobbyMetrics) -> some View {
        let sorted = data.players.sorted { $0.joinedAt < $1.joinedAt }
        VStack(spacing: m.joinGap) {
            HStack(spacing: m.gapMid) {
                QrBlockView(qrText: data.qrText, width: m.qrW, vp: vp)
                VStack(spacing: m.cardGap) {
                    ForEach(0..<m.rows, id: \.self) { r in
                        HStack(spacing: m.cardGap) {
                            ForEach(0..<m.cols, id: \.self) { c in
                                let slot = r * m.cols + c
                                let seat = slot < sorted.count ? sorted[slot] : nil
                                PlayerCardView(seat: seat, w: m.cardW, h: m.cardH, vp: vp,
                                               pop: seat.map { !seenPeers.contains($0.peerIndex) } ?? false)
                                    .id(seat?.peerIndex ?? -(slot + 1))
                            }
                        }
                    }
                }
            }
            JoinLineView(joinURL: data.joinURL, fontSize: m.joinSize)
                .frame(height: m.joinLineH)
        }
        // Stale-room pending dim covers the QR and the join line as one group
        // (the code in the line is what could mislead). Only once a QR is
        // showing: the initial relay connect also flags pending, and dimming
        // the still-blank card mid-entrance double-pumped the fade.
        .opacity(qrPending && !data.qrText.isEmpty ? Self.qrPendingAlpha : 1)
        .animation(.easeOut(duration: 0.2), value: qrPending)
    }

    // MARK: - Start

    @ViewBuilder
    private func startButton() -> some View {
        let pillH = vp.actionButtonH
        let hasPlayers = !data.players.isEmpty
        ChromeButton(
            text: hasPlayers
                ? trUpper("start_n_players", data.players.count)
                : trUpper("waiting_for_players"),
            primary: true,
            tint: UITheme.hostTint(data.hostColorSlot),
            enabled: hasPlayers,
            height: pillH,
            hPad: min(vp.w * 0.04, 96),   // web .btn padding clamp(2rem, 4vw, 6rem)
            manualFocus: focusTarget == .start,
            action: {}   // manual-focus rendering; Select routes via lobbySelect()
        )
    }
}

/// The lobby's band math, ported verbatim from the SpriteKit buildLobby so the
/// SwiftUI layout keeps the same web clamp() proportions at 1080p and 4K.
private struct LobbyMetrics {
    let cols: Int
    let rows: Int
    let cardGap: CGFloat
    let gapMid: CGFloat
    let joinSize: CGFloat
    let joinLineH: CGFloat
    let joinGap: CGFloat
    let cardW: CGFloat
    let cardH: CGFloat
    let qrW: CGFloat

    init(vp: Vp, titleH: CGFloat, playerCount: Int) {
        let W = vp.w, H = vp.h, vmin = vp.vmin
        let margin = H * 0.05
        // Show 4 placeholder slots by default (8 players are still allowed; the
        // grid grows to a 4-wide row as they join). The TV's logical width sits
        // below the web's 2400px "show 8" threshold, so 4 is the faithful default.
        let visibleSlots = min(max(4, playerCount), EngineConstants.maxPlayers)
        cols = visibleSlots > 4 ? 4 : 2
        rows = Int(ceil(Double(visibleSlots) / Double(cols)))
        cardGap = min(vmin * 0.016, 18)
        gapMid = min(vmin * 0.032, 40)

        // Join line metrics (web: one HUD face/size for URL and hint,
        // clamp(1.05rem, 2.6vmin, 1.75rem); body gap clamp(10px, 2.2vmin, 22px)).
        joinSize = min(vmin * 0.026, 28)
        joinLineH = joinSize * 1.3
        joinGap = min(vmin * 0.022, 22)

        // Web --card-w clamp(150px, 36vmin, 350px): sized so a 16-char name (the
        // platform-wide cap) fits at the full name size on a 1080p display.
        var cardW = min(vmin * 0.36, 350)
        // Web #qr-container calc(var(--card-w) + 40px): always a touch taller
        // than the two-card column beside it (2:1 cards stack to cardW + gap).
        var qrW = cardW + 40
        // Keep the QR square + join line within the band between the title band
        // and the START band.
        let pillH = vp.actionButtonH
        let bandH = H - (margin + titleH + margin * 0.5) - (margin + pillH + margin * 0.5)
        qrW = min(qrW, bandH * 0.98 - joinGap - joinLineH)
        // Horizontal fit: shrink proportionally if the widest row would overflow.
        let rowWidth = qrW + gapMid + CGFloat(cols) * cardW + CGFloat(cols - 1) * cardGap
        let budget = W * 0.96
        if rowWidth > budget { let s = budget / rowWidth; cardW *= s; qrW *= s }
        self.cardW = cardW
        self.qrW = qrW
        cardH = cardW * 0.5
    }
}

// MARK: - Entrance

/// Fade + slide a view into place (web fadeDown/fadeUp entrance keyframes).
/// `dy` is the starting offset (negative = starts above and drops).
struct Entrance: ViewModifier {
    let dy: CGFloat
    let delay: Double
    var duration: Double = 0.5
    @State private var shown = false

    func body(content: Content) -> some View {
        content
            .opacity(shown ? 1 : 0)
            .offset(y: shown ? 0 : dy)
            .onAppear {
                withAnimation(.easeOut(duration: duration).delay(delay)) { shown = true }
            }
    }
}

// MARK: - Player card

struct PlayerCardView: View {
    let seat: LobbySeat?
    let w: CGFloat
    let h: CGFloat
    let vp: Vp
    let pop: Bool

    @State private var breatheDim = false
    @State private var popped = false

    var body: some View {
        Group {
            if let seat {
                filled(seat)
                    // Join pop (web slotPopIn): scale spring + quick fade, only
                    // for a player arriving while the lobby is up.
                    .scaleEffect(pop && !popped ? 0.6 : 1.0)
                    .opacity(pop && !popped ? 0 : 1)
                    .onAppear {
                        guard pop else { popped = true; return }
                        withAnimation(.spring(response: 0.45, dampingFraction: 0.55)) { popped = true }
                    }
            } else {
                empty
            }
        }
        .frame(width: w, height: h)
    }

    /// Tonal card, borderless; the player color is mixed into the surface and
    /// carried by the name text (web .player-card A2, --shadow-sm).
    private func filled(_ seat: LobbySeat) -> some View {
        let color = UITheme.player(slot: seat.colorSlot)
        // web .identity-name clamp(1.5rem,4.5vmin,2.4rem); 10-foot cap 38.4
        // (4.5vmin = 0.25 of the 2:1 card's 18vmin height). Long names shrink
        // to fit rather than truncate, down to the web fitter's 0.6 floor.
        let nameSize = min(h * 0.25, 38.4)
        // web .card-level__* clamp(0.75rem, 2vmin, 1.15rem); cap 18.4.
        let pillFontSize = min(h * 0.11, 18.4)
        // Equal Spacers = web justify-content: space-evenly: the whitespace
        // above the name, between name and pill, and below the pill matches.
        return VStack(spacing: 0) {
            Spacer(minLength: 0)
            Text(seat.name)
                .styled(font: AppFont.brandExtraBold, size: nameSize, color: color, tracking: 0.04)
                .lineLimit(1)
                .truncationMode(.tail)
                .minimumScaleFactor(0.6)
                .frame(maxWidth: w * 0.92)
            Spacer(minLength: 0)
            // Quiet "LEVEL n" pill (web .card-level__pill): recessed dark chip,
            // heading at 0.2em tracking, value in the HUD voice.
            HStack(spacing: pillFontSize * 0.5) {
                Text(trUpper("level_heading"))
                    .styled(font: AppFont.brandBold, size: pillFontSize,
                            color: UITheme.textSecondary, tracking: 0.2)
                Text(verbatim: "\(seat.level)")
                    .styled(font: AppFont.name, size: pillFontSize,
                            color: UITheme.textPrimary(), tracking: 0)
            }
            .padding(.horizontal, pillFontSize)
            .frame(height: pillFontSize * 2.3)
            .background(Capsule().fill(UITheme.socket(0.35)))
            Spacer(minLength: 0)
        }
        .frame(width: w, height: h)
        .background(
            RoundedRectangle(cornerRadius: 20)   // web .player-card 20px
                .fill(UITheme.tonalCard(color))
                .shadow(color: .black.opacity(0.32), radius: 4, x: 0, y: 2)
        )
    }

    /// Empty slot: recessed socket (web .player-card.empty) with a faint hex
    /// opening, breathing slowly (opacity 0.5 → 0.27 → 0.5 over 3.2s). Only
    /// the hex breathes; pulsing the whole card read as background flicker
    /// once the lobby cards grew.
    private var empty: some View {
        let openW = max(28, min(vp.vmin * 0.055, 56))
        return RoundedRectangle(cornerRadius: 20)
            .fill(UITheme.socket(0.55))
            .overlay(RoundedRectangle(cornerRadius: 20).stroke(UITheme.hairline(0.05), lineWidth: 1))
            .overlay(
                RoundedHex(cornerR: openW * 0.06)
                    .fill(UITheme.hairline(0.03))
                    .overlay(RoundedHex(cornerR: openW * 0.06).stroke(UITheme.textPrimary(0.45), lineWidth: 2))
                    .frame(width: openW, height: openW)
                    .opacity(breatheDim ? 0.27 : 0.5)
            )
            .onAppear {
                withAnimation(.easeInOut(duration: 1.6).repeatForever(autoreverses: true)) {
                    breatheDim = true
                }
            }
    }
}

/// Flat-top hexagon with tangent-arc rounded corners (web
/// buildSocketOpening's SVG path; the SpriteKit roundedHexPath twin).
struct RoundedHex: Shape {
    let cornerR: CGFloat

    func path(in rect: CGRect) -> Path {
        let r = min(rect.width, rect.height) / 2
        let cx = rect.midX, cy = rect.midY
        let pts = (0..<6).map { i -> CGPoint in
            let a = CGFloat.pi / 3 * CGFloat(i)
            return CGPoint(x: cx + r * cos(a), y: cy + r * sin(a))
        }
        func mid(_ a: CGPoint, _ b: CGPoint) -> CGPoint { CGPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2) }
        var p = Path()
        p.move(to: mid(pts[5], pts[0]))
        for i in 0..<6 {
            p.addArc(tangent1End: pts[i], tangent2End: mid(pts[i], pts[(i + 1) % 6]), radius: cornerR)
        }
        p.closeSubpath()
        return p
    }
}

// MARK: - QR block

/// Frameless join block (web A2 #qr-container): the white QR square floats on
/// its own, corners baked crisp by SwiftUI shape AA (the SpriteKit port needed
/// a texture bake for this). Empty payload = no room yet: blank white card,
/// matching the web lobby's empty QR canvas. The pattern derives from state,
/// so the relay confirming the room mid-entrance just fills the already-fading
/// card (no rebuild, no double-fade).
struct QrBlockView: View {
    let qrText: String
    let width: CGFloat
    let vp: Vp

    var body: some View {
        // Corner radius clamp(14px, 2.4vmin, 22px); padding clamp(6px, 1.2vmin, 14px).
        let radius = max(14, min(vp.vmin * 0.024, 22))
        let pad = max(6, min(vp.vmin * 0.012, 14))
        RoundedRectangle(cornerRadius: radius)
            .fill(Color.white)
            .shadow(color: .black.opacity(0.32), radius: 4, x: 0, y: 2)   // --shadow-sm
            .frame(width: width, height: width)
            .overlay {
                if !qrText.isEmpty, let qr = QRCode.image(for: qrText) {
                    Image(uiImage: qr)
                        .resizable()
                        .interpolation(.none)   // hard module edges, no smear
                        // Multiply: the generated image is black-on-WHITE, and
                        // fading it as-is reads as a second white box over the
                        // white card. Multiplied, only the black modules show.
                        .blendMode(.multiply)
                        .padding(pad)
                        .transition(.opacity)
                }
            }
            // The relay usually confirms the room mid-entrance: the modules
            // fade into the already-fading card instead of popping.
            .animation(.easeOut(duration: 0.3), value: qrText)
    }
}

// MARK: - Join line

/// Host + room code, crossfading with the localized scan hint every 4.5s at
/// one shared size (web #join-line: the crossfade reads as one line changing
/// content).
struct JoinLineView: View {
    let joinURL: String
    let fontSize: CGFloat

    @State private var showHint = false
    private let beat = Timer.publish(every: 4.5, on: .main, in: .common).autoconnect()

    var body: some View {
        let (host, code) = Self.splitJoinURL(joinURL)
        Group {
            if host.isEmpty && code.isEmpty {
                Color.clear
            } else {
                line(host: host, code: code)
                    .transition(.opacity)
            }
        }
        // Fades in with the QR pattern when the room lands mid-entrance.
        .animation(.easeOut(duration: 0.3), value: joinURL)
    }

    private func line(host: String, code: String) -> some View {
            ZStack {
                // URL row: host (muted, weight 600) + code (accent, heavy,
                // 0.18em tracking) (web .join-url__host/.join-url__code).
                (Text(host).styled(font: AppFont.semibold, size: fontSize,
                                   color: UITheme.textSecondary, tracking: 0.04)
                 + Text(code).styled(font: AppFont.black, size: fontSize,
                                     color: UITheme.accentSecondary, tracking: 0.18))
                    .lineLimit(1)
                    .opacity(showHint ? 0 : 1)
                Text(tr("scan_hint"))
                    .styled(font: AppFont.semibold, size: fontSize,
                            color: UITheme.textSecondary, tracking: 0.06)
                    .opacity(showHint ? 1 : 0)
            }
            .onReceive(beat) { _ in
                withAnimation(.easeInOut(duration: 0.45)) { showHint.toggle() }
            }
    }

    /// "https://host/CODE#instance" -> ("host/", "CODE"). Mirrors renderJoinUrl.
    /// A code-less URL (the gallery/adclip clean CTA) -> ("host", "").
    static func splitJoinURL(_ url: String) -> (host: String, code: String) {
        guard let u = URL(string: url), let host = u.host else { return ("", url) }
        let code = u.path.replacingOccurrences(of: "/", with: "")
        return code.isEmpty ? (host, "") : (host + "/", code)
    }
}

// MARK: - Info button

/// Small circular ⓘ (the About entry), focused by the lobby's manual menu.
/// Recessed translucent disc + warm hairline ring (A2 .icon-btn); the glyph
/// is drawn (dot + rounded stem) so it reads as an icon and matches Android
/// regardless of the font.
struct InfoCircleButton: View {
    let diameter: CGFloat
    let focused: Bool

    var body: some View {
        let unit = diameter * 0.13     // dot diameter == stem width
        VStack(spacing: diameter * 0.055) {
            Circle().frame(width: unit, height: unit)
            Capsule().frame(width: unit, height: diameter * 0.3)
        }
        .foregroundColor(UITheme.textPrimary())
        .frame(width: diameter, height: diameter)
        .background(Circle().fill(UITheme.socket(0.4)))
        .overlay(Circle().stroke(focused ? Color.white : UITheme.hairline(0.12),
                                 lineWidth: focused ? 4 : 1))
        .scaleEffect(focused ? 1.06 : 1.0)
        .animation(.easeOut(duration: 0.15), value: focused)
    }
}

// MARK: - Title cache

/// TitleTexture bakes CoreGraphics images; cache per size so roster updates
/// re-rendering the lobby don't re-rasterize the wordmark every time.
enum TitleImageCache {
    private static var titles: [Int: UIImage] = [:]
    private static var marks: [Int: UIImage] = [:]

    static func image(mainSize: CGFloat) -> UIImage {
        let key = Int(mainSize.rounded())
        if let hit = titles[key] { return hit }
        let img = TitleTexture.make(mainSize: mainSize)
        titles[key] = img
        return img
    }

    static func mark(width: CGFloat) -> UIImage {
        let key = Int(width.rounded())
        if let hit = marks[key] { return hit }
        let img = TitleTexture.markImage(width: width)
        marks[key] = img
        return img
    }
}
