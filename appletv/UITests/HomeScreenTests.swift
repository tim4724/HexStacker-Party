import XCTest

/// Captures the tvOS home screen with the HexStacker app focused (app icon +
/// Top Shelf banner), for local review.
///
/// `simctl` can't send remote input, so this drives it via `XCUIRemote`: Menu
/// returns to the home screen from the test runner, then one d-pad Right moves
/// focus from Settings (slot 0) onto HexStacker. This class sorts first
/// (`HomeScreenTests` < `NavigationTests` < `ScreenshotTests`), so it runs while
/// the app is still freshly installed at slot 1, before the other suites launch
/// it and shuffle its home-row position. Capture-only (no assertion).
///
/// KNOWN LIMITATION: this renders crisply on a LOCAL Simulator but comes back as a
/// blurred wallpaper on GitHub's headless runner (`XCUIScreen.main.screenshot()` of
/// the tvOS springboard only captures the backdrop layer without a real display).
/// Proven not a timing issue: captures at 4s / 10s / 18s after focus were identical
/// blurs; the tvOS runtime is 26 on both CI and local, so not a version gap either.
/// Run this test on a local Simulator for a clean Top Shelf shot; the CI artifact
/// for this one screen is best-effort.
final class HomeScreenTests: XCTestCase {
    func testCaptureHomeScreenWithAppFocused() {
        // Leave the test runner for the home screen.
        XCUIRemote.shared.press(.menu)
        Thread.sleep(forTimeInterval: 2.5)
        // Focus the HexStacker icon (slot 1, after Settings) so its Top Shelf shows.
        XCUIRemote.shared.press(.right)
        Thread.sleep(forTimeInterval: 4.0)

        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "home-topshelf"
        shot.lifetime = .keepAlways
        add(shot)
    }
}
