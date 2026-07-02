import Testing
import Foundation
@testable import HexStackerKit

/// Exercises the native i18n runtime against the GENERATED locale table
/// (dist/locale.json, built by EngineFixture from public/shared/i18n.js). Proves
/// the port reproduces the web's t() semantics: EN fallback, {param} interpolation,
/// CLDR-ish plural selection, and BCP-47 locale reduction.
@Suite struct LocalizationTests {

    private func loc(_ lang: String) -> Localization {
        let l = Localization()
        l.configure(engineDirectory: EngineFixture.coreBundleDir, localeOverride: lang)
        return l
    }

    @Test func englishBaseStrings() {
        let l = loc("en")
        #expect(l.locale == "en")
        #expect(l.t("hold") == "HOLD")
        #expect(l.t("paused") == "PAUSED")
        #expect(l.t("triple") == "TRIPLE!")   // the mismatch the port had to fix
    }

    @Test func localizesPerLanguage() {
        #expect(loc("de").t("lines") == "ZEILEN")
        #expect(loc("de").t("ko") == "K.O.")          // de uses K.O., not KO
        #expect(loc("fr").t("next") == "SUIVANT")
        #expect(loc("ja").t("hold") == "ホールド")
    }

    @Test func unknownLocaleFallsBackToEnglish() {
        let l = loc("xx")
        #expect(l.locale == "en")
        #expect(l.t("hold") == "HOLD")
    }

    @Test func regionSubtagReducesToLanguage() {
        #expect(loc("pt-BR").locale == "pt")
        #expect(loc("zh-Hans-CN").locale == "zh")
        #expect(loc("DE-de").locale == "de")
    }

    @Test func interpolatesParams() {
        let l = loc("en")
        #expect(l.t("level_n", ["level": 7]) == "Level 7")
        #expect(l.t("attempt_n_of_m", ["attempt": 2, "max": 5]) == "Attempt 2 of 5")
    }

    @Test func pluralSelectionEnglish() {
        let l = loc("en")
        #expect(l.t("n_lines", ["count": 1]) == "1 line")
        #expect(l.t("n_lines", ["count": 3]) == "3 lines")
    }

    @Test func pluralSelectionRussian() {
        let l = loc("ru")
        #expect(l.t("n_lines", ["count": 1]) == "1 линия")    // one
        #expect(l.t("n_lines", ["count": 3]) == "3 линии")    // few
        #expect(l.t("n_lines", ["count": 5]) == "5 линий")    // many
        #expect(l.t("n_lines", ["count": 11]) == "11 линий")  // many (11 is not "one")
    }

    @Test func cjkUsesOtherFormOnly() {
        // zh has only the `other` plural form; selection must not crash or miss.
        #expect(loc("zh").t("n_lines", ["count": 1]) == "1 行")
    }

    @Test func missingKeyReturnsKey() {
        #expect(loc("en").t("definitely_not_a_key") == "definitely_not_a_key")
    }

    @Test func upperHelperMatchesWebButtonTransform() {
        let l = loc("en")
        #expect(l.tUpper("start_n_players", ["count": 2]) == "START (2 PLAYERS)")
        #expect(l.tUpper("scan_to_join") == "SCAN TO JOIN")
    }
}
