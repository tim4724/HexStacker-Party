import XCTest

/// Captures the tvOS home screen with the HexStacker app focused, so every CI run
/// publishes the app icon (parallax) + Top Shelf banner alongside the in-app
/// screens.
///
/// `simctl` can't send remote input, so this drives it via `XCUIRemote`: Menu
/// returns to the home screen from the test runner, then one d-pad Right moves
/// focus from Settings (slot 0) onto HexStacker. This class sorts first
/// (`HomeScreenTests` < `NavigationTests` < `ScreenshotTests`), so it runs while
/// the app is still freshly installed at slot 1, before the other suites launch
/// it and shuffle its home-row position.
///
/// Capture-only (no assertion): a different focused app would just yield a less
/// useful screenshot, never a failed build.
///
/// DIAGNOSTIC: the home capture renders crisply on a local Simulator but comes back
/// blurred on the headless CI runner. To tell whether that is a timing problem (the
/// loaded runner just needs longer for the Top Shelf to composite) from something
/// the headless runner can never render, this grabs a shot at several increasing
/// delays after focusing the app. If a later shot sharpens, it is timing; if all of
/// them blur, longer waits won't help.
final class HomeScreenTests: XCTestCase {
    func testCaptureHomeScreenWithAppFocused() {
        // Leave the test runner for the home screen.
        XCUIRemote.shared.press(.menu)
        Thread.sleep(forTimeInterval: 2.5)
        // Focus the HexStacker icon so its Top Shelf banner renders.
        XCUIRemote.shared.press(.right)

        // Cumulative waits after Right: shots at ~4s, ~10s, ~18s.
        let steps: [(name: String, extraWait: TimeInterval)] = [
            ("home-topshelf-04s", 4.0),
            ("home-topshelf-10s", 6.0),
            ("home-topshelf-18s", 8.0),
        ]
        for step in steps {
            Thread.sleep(forTimeInterval: step.extraWait)
            let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            shot.name = step.name
            shot.lifetime = .keepAlways
            add(shot)
        }
    }
}
