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

    /// Drives the lobby's native focus + the About/Licenses NavigationStack:
    /// START holds focus after the entrance stagger, d-pad Up reaches the ⓘ
    /// link, Select pushes About then Licenses, and Menu pops back one level
    /// per press (consumed by the stack, so the app must stay foregrounded).
    /// Menu is never pressed at the lobby root: there it exits to the home
    /// screen by design, which would invalidate the rest of the run.
    func testLobbyFocusAndAboutLicensesNavigation() {
        let app = XCUIApplication()
        app.launchEnvironment["HEXLOBBY"] = "1"
        // Pin the app to English so the label assertions below hold on any
        // simulator locale (the local dev simulator runs German).
        app.launchArguments += ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 20), "app did not launch")

        let remote = XCUIRemote.shared

        // Let the lobby entrance stagger settle (longest delay 0.6s + 0.5s).
        let start = app.buttons["START (3 PLAYERS)"]
        XCTAssertTrue(start.waitForExistence(timeout: 10), "lobby START button not found")
        Thread.sleep(forTimeInterval: 1.5)
        XCTAssertTrue(start.hasFocus, "START must hold focus after the entrance")

        // Up reaches the ⓘ link; Select pushes the About page.
        remote.press(.up)
        Thread.sleep(forTimeInterval: 0.5)
        remote.press(.select)
        XCTAssertTrue(app.staticTexts["PRIVACY"].waitForExistence(timeout: 5), "About page did not open")

        // The LICENSES link is About's only focusable; Select drills in.
        remote.press(.select)
        XCTAssertTrue(app.staticTexts["Lunar Joyride"].waitForExistence(timeout: 5), "Licenses list did not open")

        // Select on the first row pushes that license's text as its own page.
        remote.press(.select)
        let licenseBody = app.staticTexts.containing(
            NSPredicate(format: "label CONTAINS 'Creative Commons Attribution'")).firstMatch
        XCTAssertTrue(licenseBody.waitForExistence(timeout: 5), "license text page did not open")

        // Menu pops the text page back to the list ("Baloo 2" is a row that is
        // not part of the Lunar Joyride body, so it discriminates the pages).
        remote.press(.menu)
        XCTAssertTrue(app.staticTexts["Baloo 2"].waitForExistence(timeout: 5), "Menu did not pop back to the Licenses list")

        // Menu pops one level per press: Licenses -> About -> lobby. The
        // NavigationStack must be Menu's ONLY owner (handleMenu consumes
        // without popping): a second popper at the root double-popped on a
        // real remote press and Licenses fell straight through to the lobby.
        // Synthetic presses mask that timing (a nav controller declines a pop
        // while one is in flight), so beyond the pop itself, the assertions
        // pin the contract: About visible, lobby NOT visible, still-About 1s
        // later. The half-second press is the closest synthetic approximation
        // of the real-remote timing.
        remote.press(.menu, forDuration: 0.5)
        XCTAssertTrue(app.staticTexts["PRIVACY"].waitForExistence(timeout: 5), "Menu did not pop back to About")
        Thread.sleep(forTimeInterval: 1.0)
        XCTAssertFalse(start.exists, "Menu from Licenses must stop at About, not fall through to the lobby")
        XCTAssertTrue(app.staticTexts["PRIVACY"].exists, "About must still be up 1s after the pop")
        remote.press(.menu)
        XCTAssertTrue(start.waitForExistence(timeout: 5), "Menu did not pop back to the lobby")
        Thread.sleep(forTimeInterval: 1.5)
        // The stack restores focus to the element that pushed (the ⓘ), the
        // native back-navigation contract; Down then returns to START.
        XCTAssertTrue(app.buttons["info-button"].hasFocus, "focus must restore to the ⓘ after the pop")
        remote.press(.down)
        Thread.sleep(forTimeInterval: 0.5)
        XCTAssertTrue(start.hasFocus, "d-pad Down must reach START from the ⓘ")
        XCTAssertEqual(app.state, .runningForeground, "the stack must consume Menu (no app exit)")
    }
}
