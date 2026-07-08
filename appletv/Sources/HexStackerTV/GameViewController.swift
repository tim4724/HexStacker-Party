import UIKit
import SpriteKit
import AVFoundation

/// Presents the RootScene in an SKView and configures audio playback. The scene
/// is created once the view has a non-zero size so the layout math is correct.
final class GameViewController: UIViewController {

    private var presented = false

    // Gallery carousel: with HEXGALLERY set, present a FRESH RootScene per frozen
    // state in a SINGLE app launch (the UI test advances with Play/Pause), instead
    // of the app cold-launching once per state, the bulk of the old macOS CI cost.
    // This list is the single source of truth for the gallery order (mirrors the
    // `tvos` entries in scripts/gallery/scenarios.json); the UI test reads each
    // state's name back through the accessibility marker (see viewDidLoad), so the
    // screenshot names can't drift out of sync with what's on screen.
    private let galleryMode = ProcessInfo.processInfo.environment["HEXGALLERY"] != nil
    private let galleryStates: [(name: String, shot: String, players: Int)] = [
        ("lobby", "lobby", 4),
        ("lobby-2p", "lobby", 2),
        ("lobby-8p", "lobby", 8),
        ("lobby-empty", "lobby-empty", 0),
        ("countdown", "countdown", 4),
        ("game", "game", 4),
        ("game-lv8", "game-lv8", 4),
        ("game-lv12", "game-lv12", 4),
        ("game-2p", "game-2p", 2),
        ("game-3p", "game-3p", 3),
        ("game-4p", "game-4p", 4),
        ("game-8p", "game-8p", 8),
        ("pause", "pause", 4),
        ("pause-music", "pause-music", 4),
        ("disconnected-controller", "disconnected-controller", 4),
        ("create-error-retry", "create-error-retry", 0),
        ("create-error", "create-error", 0),
        ("reconnecting", "reconnecting", 4),
        ("disconnected-display", "disconnected-display", 4),
        ("results", "results", 4),
        ("results-solo", "results-solo", 1),
        ("about", "about", 0),
        ("licenses", "licenses", 0),
    ]
    private var galleryIndex = 0

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
            // Bridge the carousel state to XCUITest through the render view itself
            // (a plain UIView, reliably surfaced to XCUITest, unlike SKNodes):
            // `accessibilityLabel` carries the total state count, `accessibilityValue`
            // the currently-rendered state's name (set once RootScene signals ready).
            // "pending" is a sentinel the test waits past for the first real state.
            if galleryMode {
                skView.isAccessibilityElement = true
                skView.accessibilityIdentifier = "hexshot-marker"
                skView.accessibilityLabel = String(galleryStates.count)
                skView.accessibilityValue = "pending"
            }
        }

        // Move focus by SWIPING the remote's touch surface too (not just the
        // d-pad click ring) — our SpriteKit buttons aren't UIKit-focusable, so
        // the system focus engine ignores swipes. Skipped in gallery mode, where
        // Play/Pause is the only input and it advances the carousel.
        if !galleryMode {
            for dir in [UISwipeGestureRecognizer.Direction.left, .right, .up, .down] {
                let g = UISwipeGestureRecognizer(target: self, action: #selector(handleSwipe(_:)))
                g.direction = dir
                view.addGestureRecognizer(g)
            }
        }

        // Leaving the app (Home / app switch) backgrounds it on tvOS. Unlike the
        // web's pagehide (the page is gone for good), backgrounding is
        // recoverable, so the party survives: suspend the relay socket and let
        // the controllers wait on their reconnect overlays.
        NotificationCenter.default.addObserver(
            self, selector: #selector(appDidEnterBackground),
            name: UIApplication.didEnterBackgroundNotification, object: nil)
        // Coming back rejoins the same room and re-welcomes the waiting
        // controllers (not posted on first launch).
        NotificationCenter.default.addObserver(
            self, selector: #selector(appWillEnterForeground),
            name: UIApplication.willEnterForegroundNotification, object: nil)
        // Resign-active fires while SpriteKit is still rendering (didEnterBackground
        // is too late: SKView pauses and the system snapshot — what the return
        // transition shows — is already taken), so it's where the lobby QR dims
        // against the room being gone on return. Become-active undoes it for a
        // transient resign that never backgrounded.
        NotificationCenter.default.addObserver(
            self, selector: #selector(appWillResignActive),
            name: UIApplication.willResignActiveNotification, object: nil)
        NotificationCenter.default.addObserver(
            self, selector: #selector(appDidBecomeActive),
            name: UIApplication.didBecomeActiveNotification, object: nil)
    }

    @objc private func appDidEnterBackground() {
        rootScene?.appDidEnterBackground()
    }

    @objc private func appWillEnterForeground() {
        rootScene?.appWillEnterForeground()
    }

    @objc private func appWillResignActive() {
        rootScene?.appWillResignActive()
    }

    @objc private func appDidBecomeActive() {
        rootScene?.appDidBecomeActive()
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
            if galleryMode {
                presentGalleryState(in: skView)
            } else {
                let scene = RootScene(size: skView.bounds.size)
                scene.scaleMode = .resizeFill
                skView.presentScene(scene)
            }
        } else {
            skView.scene?.size = skView.bounds.size
        }
    }

    /// Present a fresh scene frozen on the current gallery state. A new scene per
    /// state (rather than mutating one in place) means no overlay/focus state can
    /// leak between screens, so each capture is as clean as a fresh app launch.
    private func presentGalleryState(in skView: SKView) {
        let state = galleryStates[galleryIndex]
        let scene = RootScene(size: skView.bounds.size)
        scene.scaleMode = .resizeFill
        scene.shotOverride = (name: state.name, shot: state.shot, playerCount: state.players)
        scene.onShotRendered = { [weak skView] name in
            // Publish the rendered state's name for the UI test to read + capture.
            skView?.accessibilityValue = name
        }
        skView.presentScene(scene)
    }

    /// Advance to the next gallery state. The marker keeps reporting the PREVIOUS
    /// name until the new scene signals ready, so the UI test reliably waits for a
    /// changed value before capturing.
    private func advanceGallery() {
        guard galleryMode, let skView = view as? SKView else { return }
        guard galleryIndex + 1 < galleryStates.count else { return }
        galleryIndex += 1
        presentGalleryState(in: skView)
    }

    // Siri Remote (display-side controls): Select activates the focused button;
    // Play/Pause is the context action (Start / Pause / Continue / Play Again);
    // Menu pauses during a game (exits normally at the top level); d-pad
    // Left/Right move focus. Music is toggled from the pause overlay (not a
    // remote button). A paired keyboard mirrors these (Return=select,
    // P=play/pause, ←/→=focus, Esc=menu).
    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        // Gallery mode: Play/Pause (or keyboard P) advances the carousel; every
        // other press is swallowed so it can't disturb the frozen capture.
        if galleryMode {
            for press in presses where press.type == .playPause || press.key?.keyCode == .keyboardP {
                advanceGallery()
            }
            return
        }

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
