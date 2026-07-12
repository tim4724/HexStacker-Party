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
/// state; the transition matrix rides the model's withAnimation transactions
/// through plain .opacity transitions.
struct DisplayChromeView: View {
    @ObservedObject var model: DisplayModel

    private var ui: UiModel { model.state }

    var body: some View {
        GeometryReader { geo in
            let vp = Vp(size: geo.size)
            ZStack {
                SpriteView(scene: model.boardScene,
                           options: [.ignoresSiblingOrder],
                           debugOptions: ProcessInfo.processInfo.environment["HEXFPS"] != nil
                               ? [.showsFPS, .showsNodeCount] : [])
                    .ignoresSafeArea()

                Group {
                    switch ui.screen {
                    case .lobby:
                        // About/Licenses REPLACE the lobby (not layer over it)
                        // so d-pad focus can't leak into covered buttons. The
                        // swap fades via the withAnimation transactions in the
                        // model's open/close paths (Android lobbyPage parity).
                        if ui.showLicenses {
                            LicensesView()
                                .transition(.opacity)
                        } else if ui.showAbout {
                            AboutView(vp: vp,
                                      onOpenLicenses: { model.openLicenses() })
                                .transition(.opacity)
                        } else {
                            LobbyView(data: ui.lobby ?? LobbyData(),
                                      qrPending: ui.qrPending,
                                      vp: vp,
                                      focusTarget: ui.lobbyFocus)
                                // Entry is an instant swap (the entrance stagger
                                // is the transition, web parity); the EXIT fades,
                                // so match start reads as one unit: the lobby
                                // dissolves over the boards while the countdown
                                // scrim fades in (Android AnimatedContent parity).
                                .transition(.asymmetric(insertion: .identity, removal: .opacity))
                        }
                    case .results:
                        ResultsView(results: ui.results,
                                    hostColorSlot: ui.hostColorSlot,
                                    vp: vp,
                                    onPlayAgain: { model.playAgain() },
                                    onNewGame: { model.newGame() })
                            .transition(.opacity)
                    case .game:
                        if let value = ui.countdown {
                            // Inserted at FULL opacity: the outgoing lobby or
                            // results dissolves over [boards + countdown] as a
                            // composite, instead of boards showing through a
                            // half-faded scrim. Only the GO dismissal fades.
                            CountdownOverlayView(value: value, paused: ui.paused, vp: vp)
                                .transition(.asymmetric(insertion: .identity, removal: .opacity))
                        }
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
                }
            }
        }
        .background(UITheme.bgPrimary)
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
