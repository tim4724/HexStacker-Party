import SwiftUI

@main
struct HexStackerApp: App {
    var body: some Scene {
        WindowGroup {
            RootHost()
                .ignoresSafeArea()
        }
    }
}

/// UIKit shim between the SwiftUI lifecycle and the chrome: the root view
/// controller owns the remote's focus-independent buttons (Play/Pause, Menu)
/// via pressesBegan. SwiftUI's onPlayPauseCommand/onExitCommand ride the focus
/// chain and are never delivered while nothing is focusable (countdown, live
/// gameplay), which is exactly when Play/Pause = pause and Menu = pause
/// matter. As the root, this controller sits in every responder chain, focused
/// or not. Select and the d-pad stay with the native focus engine.
private struct RootHost: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> PressHostController { PressHostController() }
    func updateUIViewController(_ controller: PressHostController, context: Context) {}
}

final class PressHostController: UIViewController {
    private let model = DisplayModel()

    override func viewDidLoad() {
        super.viewDidLoad()
        let host = UIHostingController(rootView: DisplayRootView(model: model))
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        // Brand plum instead of the default systemBackground: the hosting
        // view is visible for a beat between the launch screen and SwiftUI's
        // first frame, and systemBackground flashed light grey there.
        view.backgroundColor = SKTheme.bgPrimary
        host.view.backgroundColor = SKTheme.bgPrimary
        view.addSubview(host.view)
        host.didMove(toParent: self)
    }

    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        guard !model.galleryMode else {
            // Gallery: Play/Pause advances the carousel; everything else is
            // swallowed so a stray press can't disturb a frozen capture.
            for press in presses where press.type == .playPause { model.advanceGallery() }
            return
        }
        var handled = false
        for press in presses {
            switch press.type {
            case .playPause:
                model.playPause()
                handled = true
            case .menu:
                // At the top level handleMenu() declines and the press falls
                // through to super for the default exit to the home screen.
                handled = model.handleMenu()
            default:
                break
            }
        }
        if !handled { super.pressesBegan(presses, with: event) }
    }
}
