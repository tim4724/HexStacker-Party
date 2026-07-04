import XCTest

/// Captures every frozen display state for the cross-platform gallery in a SINGLE
/// app launch. The app (HEXGALLERY) presents a fresh scene per state and reports
/// the rendered state's name through an accessibility marker; this test reads that
/// name, captures the screen, and presses Play/Pause to advance. One launch (vs
/// the old one cold launch per state) is the bulk of the macOS CI speed-up, and
/// each captured screen still doubles as a "this state renders without crashing"
/// check.
///
/// The app owns the ordered state list (`GameViewController.galleryStates`, which
/// mirrors the `tvos` entries in scripts/gallery/scenarios.json) and reports each
/// name, so attachment names can't drift out of order. The TV Gallery workflow
/// matches attachments by that name.
final class ScreenshotTests: XCTestCase {

    override func setUp() {
        // One bad screen shouldn't hide the rest of the gallery.
        continueAfterFailure = true
    }

    func testCaptureEveryDisplayState() {
        let app = XCUIApplication()
        app.launchEnvironment["HEXGALLERY"] = "1"
        app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 20),
                      "app did not reach the foreground")

        // The render view exposes the carousel state: label = total count,
        // value = currently-rendered state name ("pending" until the first frame).
        let marker = app.descendants(matching: .any)
            .matching(identifier: "hexshot-marker").firstMatch
        XCTAssertTrue(marker.waitForExistence(timeout: 20), "gallery marker never appeared")

        let total = Int(marker.label) ?? 0
        XCTAssertGreaterThan(total, 0, "gallery reported no states (label=\(marker.label))")

        var lastName = "pending"
        for i in 0..<total {
            // Wait for the marker's value to CHANGE to the next state's name (it
            // holds the previous name through the scene swap, so a changed value
            // means the new frozen frame is on screen and settled).
            let changed = NSPredicate(format: "value != %@", lastName)
            let exp = XCTNSPredicateExpectation(predicate: changed, object: marker)
            XCTAssertEqual(XCTWaiter().wait(for: [exp], timeout: 15), .completed,
                           "state \(i): app never signalled the next frozen frame")

            let name = (marker.value as? String) ?? ""
            let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            attachment.name = name
            attachment.lifetime = .keepAlways   // keep on success, not just failure
            add(attachment)
            lastName = name

            if i < total - 1 { XCUIRemote.shared.press(.playPause) }
        }
    }
}
