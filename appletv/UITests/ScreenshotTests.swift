import XCTest

/// Launches the tvOS app into each frozen display state and captures a
/// full-screen screenshot per state as a test attachment.
///
/// State is selected through the app's existing `HEXSHOT` render hooks, set here
/// via `launchEnvironment` — so the fixture/demo setup lives in this test target,
/// not in a live relay session or extra production code. `HEXSHOT` renders fake
/// fixture data and stops ticking, so each shot is a stable screen (no relay, no
/// controllers).
///
/// The screenshots are the deliverable: extract them from the `.xcresult` in CI
/// (`xcparse screenshots`) and publish them as an artifact / gallery. Each state
/// also doubles as a launch smoke test — the app must reach the foreground
/// without crashing on every screen.
final class ScreenshotTests: XCTestCase {

    /// name : HEXSHOT state : HEXPLAYERS — mirrors the `tvos` entries in the
    /// repo-root scripts/gallery/scenarios.json (names must stay the canonical
    /// scenario keys: the TV Gallery workflow matches attachments by that name).
    private let states: [(name: String, shot: String, players: String)] = [
        ("lobby", "lobby", "4"),
        ("lobby-2p", "lobby", "2"),
        ("lobby-8p", "lobby", "8"),
        ("lobby-empty", "lobby-empty", "0"),
        ("countdown", "countdown", "4"),
        ("game", "game", "4"),
        ("game-lv8", "game-lv8", "4"),
        ("game-lv12", "game-lv12", "4"),
        // Player count comes from the variant spec for these; HEXPLAYERS is passed
        // for clarity only (the shot ignores it).
        ("game-2p", "game-2p", "2"),
        ("game-3p", "game-3p", "3"),
        ("game-4p", "game-4p", "4"),
        ("pause", "pause", "4"),
        ("pause-music", "pause-music", "4"),
        ("disconnected-controller", "disconnected-controller", "4"),
        ("reconnecting", "reconnecting", "4"),
        ("disconnected-display", "disconnected-display", "4"),
        ("results", "results", "4"),
        ("results-solo", "results-solo", "1"),
    ]

    override func setUp() {
        // Capture every state even if one screen regresses, so the gallery is
        // always complete and a single bad screen doesn't hide the rest.
        continueAfterFailure = true
    }

    func testCaptureEveryDisplayState() {
        for state in states {
            let app = XCUIApplication()
            app.launchEnvironment["HEXSHOT"] = state.shot
            app.launchEnvironment["HEXPLAYERS"] = state.players
            app.launch()

            XCTAssertTrue(app.wait(for: .runningForeground, timeout: 20),
                          "\(state.name): app did not reach the foreground")
            // Let the scene present and render the frozen state before capturing.
            Thread.sleep(forTimeInterval: 3.0)

            let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            attachment.name = state.name
            attachment.lifetime = .keepAlways   // keep on success, not just failure
            add(attachment)

            app.terminate()
        }
    }
}
