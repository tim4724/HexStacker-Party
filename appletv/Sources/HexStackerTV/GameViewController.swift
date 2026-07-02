import UIKit
import SpriteKit
import AVFoundation

/// Presents the RootScene in an SKView and configures audio playback. The scene
/// is created once the view has a non-zero size so the layout math is correct.
final class GameViewController: UIViewController {

    private var presented = false

    override func loadView() {
        view = SKView()
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
        try? AVAudioSession.sharedInstance().setActive(true)

        // Keep the screen awake: this display is driven by the phones, so the TV
        // itself receives no input and tvOS would otherwise start the screensaver
        // over the lobby QR / live game. tvOS restores the idle timer when the app
        // backgrounds, so this is scoped to the foreground session.
        UIApplication.shared.isIdleTimerDisabled = true

        if let skView = view as? SKView {
            skView.ignoresSiblingOrder = true
            // The FPS / node overlays sit in the bottom-right overscan corner, so
            // keep them off by default; enable with HEXFPS=1 when profiling.
            if ProcessInfo.processInfo.environment["HEXFPS"] != nil {
                skView.showsFPS = true
                skView.showsNodeCount = true
            }
        }

        // Move focus by SWIPING the remote's touch surface too (not just the
        // d-pad click ring) — our SpriteKit buttons aren't UIKit-focusable, so
        // the system focus engine ignores swipes.
        for dir in [UISwipeGestureRecognizer.Direction.left, .right, .up, .down] {
            let g = UISwipeGestureRecognizer(target: self, action: #selector(handleSwipe(_:)))
            g.direction = dir
            view.addGestureRecognizer(g)
        }

        // Leaving the app (Home / app switch) backgrounds it on tvOS: tell the
        // controllers the display is going away (the web does this on pagehide) so
        // they show the end screen instead of a reconnect-forever overlay.
        NotificationCenter.default.addObserver(
            self, selector: #selector(appDidEnterBackground),
            name: UIApplication.didEnterBackgroundNotification, object: nil)
        // Coming back needs the inverse: controllers were told the display
        // closed, so re-join and re-welcome them (not posted on first launch).
        NotificationCenter.default.addObserver(
            self, selector: #selector(appWillEnterForeground),
            name: UIApplication.willEnterForegroundNotification, object: nil)
    }

    @objc private func appDidEnterBackground() {
        rootScene?.notifyDisplayClosing()
    }

    @objc private func appWillEnterForeground() {
        rootScene?.appWillEnterForeground()
    }

    private var rootScene: RootScene? { (view as? SKView)?.scene as? RootScene }

    @objc private func handleSwipe(_ g: UISwipeGestureRecognizer) {
        switch g.direction {
        case .left: rootScene?.remoteLeft()
        case .right: rootScene?.remoteRight()
        case .up: rootScene?.remoteUp()
        case .down: rootScene?.remoteDown()
        default: break
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        guard let skView = view as? SKView, skView.bounds.width > 0 else { return }
        if !presented {
            presented = true
            let scene = RootScene(size: skView.bounds.size)
            scene.scaleMode = .resizeFill
            skView.presentScene(scene)
        } else {
            skView.scene?.size = skView.bounds.size
        }
    }

    // Siri Remote (display-side controls): Select activates the focused button;
    // Play/Pause is the context action (Start / Pause / Continue / Play Again);
    // Menu pauses during a game (exits normally at the top level); d-pad
    // Left/Right move focus. Music is toggled from the pause overlay (not a
    // remote button). A paired keyboard mirrors these (Return=select,
    // P=play/pause, ←/→=focus, Esc=menu).
    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        let scene = (view as? SKView)?.scene as? RootScene
        var handled = false
        for press in presses {
            var did = false
            if let key = press.key {
                switch key.keyCode {
                case .keyboardReturnOrEnter, .keypadEnter, .keyboardSpacebar:
                    scene?.remotePrimary(); did = true
                case .keyboardP: scene?.remotePlayPause(); did = true
                case .keyboardLeftArrow: scene?.remoteLeft(); did = true
                case .keyboardRightArrow: scene?.remoteRight(); did = true
                case .keyboardUpArrow: scene?.remoteUp(); did = true
                case .keyboardDownArrow: scene?.remoteDown(); did = true
                case .keyboardEscape: did = scene?.remoteMenu() ?? false
                default: break
                }
            }
            if !did {
                switch press.type {
                case .select: scene?.remotePrimary(); did = true
                case .playPause: scene?.remotePlayPause(); did = true
                case .menu: did = scene?.remoteMenu() ?? false
                case .leftArrow: scene?.remoteLeft(); did = true
                case .rightArrow: scene?.remoteRight(); did = true
                case .upArrow: scene?.remoteUp(); did = true
                case .downArrow: scene?.remoteDown(); did = true
                default: break
                }
            }
            handled = handled || did
        }
        if !handled { super.pressesBegan(presses, with: event) }
    }
}
