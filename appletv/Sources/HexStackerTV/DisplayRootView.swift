import SwiftUI
import SpriteKit

/// SwiftUI root: hosts the SpriteKit board scene and composites the chrome
/// above it (Android DisplayChrome parity). The model is owned by the
/// PressHostController shim (App.swift), which needs it for remote presses.
struct DisplayRootView: View {
    @ObservedObject var model: DisplayModel

    var body: some View {
        // No .ignoresSafeArea() here: the chrome lays out inside the tvOS
        // title-safe area (the old playRect; the simulator reports zero insets,
        // real TVs the overscan margins). Full-bleed layers opt out per-view
        // (the SpriteView below, each overlay's scrim fill).
        DisplayChromeView(model: model)
            .onAppear { model.start() }
            // UIKit lifecycle notifications, not scenePhase: the
            // resign-active vs didEnterBackground distinction feeds the QR
            // pending dim (the system snapshot is taken before backgrounding).
            .onReceive(NotificationCenter.default.publisher(
                for: UIApplication.didEnterBackgroundNotification)) { _ in model.appDidEnterBackground() }
            .onReceive(NotificationCenter.default.publisher(
                for: UIApplication.willEnterForegroundNotification)) { _ in model.appWillEnterForeground() }
            .onReceive(NotificationCenter.default.publisher(
                for: UIApplication.willResignActiveNotification)) { _ in model.appWillResignActive() }
            .onReceive(NotificationCenter.default.publisher(
                for: UIApplication.didBecomeActiveNotification)) { _ in model.appDidBecomeActive() }
    }
}

/// The full compositing stack, bottom-up: board scene, active screen,
/// countdown, pause, connection overlay. Screen/overlay presence is pure
/// state; every change fades through plain .opacity transitions riding the
/// model's single withAnimation token, except the countdown's insertion,
/// which reveals complete beneath the outgoing screen's fade (see below).
struct DisplayChromeView: View {
    @ObservedObject var model: DisplayModel

    private var ui: UiModel { model.state }

    var body: some View {
        GeometryReader { geo in
            let vp = Vp(fullScreenOf: geo)
            ZStack {
                // allowsTransparency: the SKView's FIRST drawable presents
                // before the scene renders and clears opaque (a white/grey
                // flash right after the launch screen). Transparent, that
                // frame shows the plum .background beneath; every later frame
                // is filled by the scene's own opaque background anyway.
                SpriteView(scene: model.boardScene,
                           options: [.ignoresSiblingOrder, .allowsTransparency],
                           debugOptions: ProcessInfo.processInfo.environment["HEXFPS"] != nil
                               ? [.showsFPS, .showsNodeCount] : [])
                    .ignoresSafeArea()

                // Static stacking order (web z-index parity): SwiftUI renders
                // an inserted branch above the one being removed, so screens
                // sit at 1 and the countdown reveal at 0 (an outgoing screen
                // dissolves ON TOP of the revealed composite), with overlays
                // above everything.
                switch ui.screen {
                case .lobby:
                    // The lobby owns a NavigationStack: About and its Licenses
                    // drill-in are pushed destinations, so tvOS itself seats
                    // focus on each pushed page, restores it on the way back,
                    // and pops on Menu. The path lives in the model so the
                    // gallery can seed it and a match start can clear it.
                    NavigationStack(path: Binding(
                        get: { model.state.aboutPath },
                        set: { model.setAboutPath($0) })
                    ) {
                        LobbyView(data: ui.lobby ?? LobbyData(),
                                  qrPending: ui.qrPending,
                                  vp: vp,
                                  onStart: { model.startMatch() })
                            .navigationDestination(for: AboutRoute.self) { route in
                                switch route {
                                case .about: AboutView(vp: vp)
                                case .licenses: LicensesListView()
                                case .license(let i): LicenseTextView(index: i)
                                }
                            }
                    }
                    .transition(.opacity)
                    .zIndex(1)
                case .results:
                    ResultsView(results: ui.results,
                                hostColorSlot: ui.hostColorSlot,
                                vp: vp,
                                onPlayAgain: { model.startMatch() },
                                onNewGame: { model.newGame() })
                        .transition(.opacity)
                        .zIndex(1)
                case .game:
                    if let value = ui.countdown {
                        // Fade-through on match start (web SCREEN_EXIT): the
                        // countdown composite (scrim + digit over the boards)
                        // is revealed COMPLETE beneath the outgoing screen's
                        // fade, so the boards never show undimmed. A faded-in
                        // scrim left them bright for its first half.
                        CountdownOverlayView(value: value, paused: ui.paused, vp: vp)
                            .transition(.asymmetric(insertion: .identity, removal: .opacity))
                            .zIndex(0)
                    }
                }

                // The relay-link overlay outranks the pause scrim (web fadeHides
                // the pause overlay under the reconnect overlay); paused survives
                // underneath, so this fades back in on recovery.
                if ui.paused && ui.screen == .game && !ui.connectionOverlayUp {
                    PauseOverlayView(hostColorSlot: ui.hostColorSlot,
                                     musicOn: !ui.muted,
                                     vp: vp,
                                     focusMusicForShot: ui.focusMusicForShot,
                                     onToggleMusic: { model.toggleMusic() },
                                     onContinue: { model.togglePause() },
                                     onNewGame: { model.newGame() })
                        .transition(.opacity)
                        .zIndex(2)
                }

                if ui.connectionOverlayUp {
                    ConnectionOverlayView(disconnected: ui.connection == .closed,
                                          showReconnect: !ui.replaced,
                                          attempt: ui.reconnectAttempt,
                                          maxAttempts: ui.reconnectMax,
                                          hostColorSlot: ui.hostColorSlot,
                                          vp: vp,
                                          onReconnect: { model.reconnectNow() })
                        .transition(.opacity)
                        .zIndex(3)
                }
            }
        }
        .background(UITheme.bgPrimary)
        // Frozen-capture modes (HEXGALLERY / HEXSHOT) want settled end frames,
        // never mid-flight ones: zero every animation at the root instead of
        // gating each animation site, so an animation added tomorrow can't
        // reintroduce mid-entrance gallery captures. Also freezes the
        // repeat-forever loops (socket breathe) at their end value, making
        // captures deterministic.
        .transaction { t in
            if model.shotMode {
                t.disablesAnimations = true
                t.animation = nil
            }
        }
        // Play/Pause and Menu are handled in the UIKit responder chain by the
        // PressHostController root (App.swift), NOT by SwiftUI command
        // modifiers: those route through the focus chain and are never
        // delivered while nothing is focusable (countdown, live gameplay),
        // which is exactly when Play/Pause = pause and Menu = pause matter.
        // Select and the d-pad stay with the native focus engine.
        .modifier(GalleryMarker(model: model))
    }
}

/// Gallery carousel bridge (HEXGALLERY): expose the rendered state's name to
/// XCUITest through the accessibility tree — label carries the total state
/// count, value the current state (starts at the "pending" sentinel).
private struct GalleryMarker: ViewModifier {
    @ObservedObject var model: DisplayModel

    func body(content: Content) -> some View {
        if model.galleryMode {
            content
                .accessibilityElement(children: .ignore)
                .accessibilityIdentifier("hexshot-marker")
                .accessibilityLabel(String(DisplayModel.galleryStates.count))
                .accessibilityValue(model.galleryMarker)
        } else {
            content
        }
    }
}
