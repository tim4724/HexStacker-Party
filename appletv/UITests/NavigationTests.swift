import XCTest

/// Drives the Siri Remote against a live self-playing game (`HEXDEMO`) to exercise
/// the display-side input path end to end: the app renders a running game,
/// Play/Pause pauses and resumes it, and the d-pad moves focus across the pause
/// overlay — all without crashing (the app stays foregrounded). No screenshots:
/// the CI artifact carries only the gallery states (ScreenshotTests); the pause /
/// focus visuals are covered by the pause and pause-music gallery rows.
///
/// Only Play/Pause + d-pad are used, deliberately not Menu: at the top level
/// `menu` is not consumed by the app and tvOS backgrounds it, which would
/// invalidate the rest of the flow. During a game the app consumes it, but
/// Play/Pause is the unambiguous, always-safe toggle.
final class NavigationTests: XCTestCase {

    override func setUp() { continueAfterFailure = false }

    func testRemoteDrivesPauseAndFocus() {
        let app = XCUIApplication()
        app.launchEnvironment["HEXDEMO"] = "1"
        app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 20), "app did not launch")

        let remote = XCUIRemote.shared

        // Let the 3-2-1 countdown finish and the self-play game get going.
        Thread.sleep(forTimeInterval: 5.0)
        XCTAssertEqual(app.state, .runningForeground)

        // Play/Pause toggles the pause overlay.
        remote.press(.playPause)
        Thread.sleep(forTimeInterval: 1.5)
        XCTAssertEqual(app.state, .runningForeground, "Play/Pause must not crash or background the app")

        // d-pad moves focus across the pause-overlay buttons (Continue / New Game
        // and the music switch row).
        for dir: XCUIRemote.Button in [.down, .up, .left, .right] {
            remote.press(dir)
            Thread.sleep(forTimeInterval: 0.4)
        }
        XCTAssertEqual(app.state, .runningForeground)

        // Resume the game.
        remote.press(.playPause)
        Thread.sleep(forTimeInterval: 1.5)
        XCTAssertEqual(app.state, .runningForeground)
    }
}
