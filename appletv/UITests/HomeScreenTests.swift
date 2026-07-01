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
final class HomeScreenTests: XCTestCase {
    func testCaptureHomeScreenWithAppFocused() {
        // Leave the test runner for the home screen.
        XCUIRemote.shared.press(.menu)
        Thread.sleep(forTimeInterval: 2.5)
        // Focus the HexStacker icon so its Top Shelf banner renders.
        XCUIRemote.shared.press(.right)
        Thread.sleep(forTimeInterval: 4.0)   // let the Top Shelf banner load in

        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "home-topshelf"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
