import Testing
import Foundation
import JavaScriptCore

/// Cross-engine conformance: drives the EXACT deterministic timeline that
/// produced tests/fixtures/partycore-frame-golden.json (recorded under V8/Node)
/// through the canonical engine running in JavaScriptCore, and asserts the
/// per-frame { deltaMs, events, commands, boards:[gridHash, snapHash] } stream
/// is identical byte-for-byte.
///
/// This is the JSC leg of the harness the Android port already runs in QuickJS
/// (android/.../FrameGoldenConformanceTest.kt): the SAME JS driver (bundled
/// from tests/helpers/partycore-frame-script.js by
/// scripts/build-conformance-bundle.js) with zero reimplementation, so a green
/// run proves the engine the shipping tvOS app executes is faithful to the
/// recorded golden. The recorded values are hashes/ints/strings, but a float
/// divergence between V8 and JSC would still move a piece and flip a hash.
@Suite struct FrameGoldenConformanceTests {

    @Test func jscReproducesFrameGoldenByteForByte() throws {
        let driverURL = EngineFixture.frameTestBundle
        let driver = try String(contentsOf: driverURL, encoding: .utf8)
        let golden = try String(contentsOf: EngineFixture.frameGolden, encoding: .utf8)

        let ctx = try #require(JSContext(), "Could not create JSContext")
        var jsException: String?
        ctx.exceptionHandler = { _, exc in jsException = exc?.toString() ?? "unknown JS exception" }

        ctx.evaluateScript(driver, withSourceURL: driverURL)
        try #require(jsException == nil, "driver bundle failed to evaluate: \(jsException ?? "")")

        let result = ctx.evaluateScript("JSON.stringify(HexFrameTest.runPartyCoreFrameScript(), null, 2)")
        try #require(jsException == nil, "runPartyCoreFrameScript threw: \(jsException ?? "")")
        let produced = try #require(result?.toString(), "driver returned no output")

        var expected = golden
        while expected.hasSuffix("\n") { expected.removeLast() }
        if produced != expected { failFirstDivergence(expected: expected, actual: produced) }
    }

    /// A 73 KB string diff is useless in an assertion; pinpoint the first differing line instead.
    private func failFirstDivergence(expected: String, actual: String) {
        let e = expected.components(separatedBy: "\n")
        let a = actual.components(separatedBy: "\n")
        let n = min(e.count, a.count)
        var i = 0
        while i < n && e[i] == a[i] { i += 1 }
        var window: [String] = []
        for idx in max(0, i - 2)...min(max(e.count, a.count) - 1, i + 2) {
            window.append("  [\(idx)] exp: \(idx < e.count ? e[idx] : "<none>")")
            window.append("  [\(idx)] got: \(idx < a.count ? a[idx] : "<none>")")
        }
        Issue.record("""
        JavaScriptCore frame() output diverged from the V8 golden at line \(i) \
        (expected \(e.count) lines, got \(a.count)):
        \(window.joined(separator: "\n"))
        """)
    }
}
