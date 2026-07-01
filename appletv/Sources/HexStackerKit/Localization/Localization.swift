import Foundation

/// Runtime i18n for the native display, mirroring public/shared/i18n.js. The
/// string table is GENERATED from that same file into `dist/locale.json` (see
/// scripts/build.js `buildLocale`) and bundled next to the engine, so the TV copy
/// can never drift from the web wording. This type only carries the *runtime*
/// behavior the web gets from `t()` + Intl.PluralRules: locale detection, plural
/// selection, and `{param}` interpolation, with an `en` fallback.
///
/// Single-threaded: configure once on the main thread at startup; read from the
/// main thread (all rendering and relay callbacks run there).
public final class Localization {

    public static let shared = Localization()

    /// locale code -> key -> (String | { plural-category: String }).
    private var table: [String: [String: Any]] = [:]
    public private(set) var locale = "en"

    public init() {}

    // MARK: - Configuration

    /// Load `locale.json` from the engine asset directory and pick the active
    /// locale. `localeOverride` (or the HEXLANG env var) forces a locale; otherwise
    /// the device's preferred language is used, falling back to English.
    public func configure(engineDirectory: URL, localeOverride: String? = nil) {
        load(from: engineDirectory)
        setLocale(localeOverride ?? Self.detectPreferredLocale())
    }

    private func load(from directory: URL) {
        let url = directory.appendingPathComponent("locale.json")
        guard let data = try? Data(contentsOf: url),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: [String: Any]] else {
            return
        }
        table = obj
    }

    /// Mirror of i18n.js `setLocale`: take the primary subtag, lowercase, fall back
    /// to `en` when the locale isn't in the table.
    public func setLocale(_ lang: String) {
        let code = lang.lowercased()
            .split(whereSeparator: { $0 == "-" || $0 == "_" })
            .first.map(String.init) ?? "en"
        locale = (table[code] != nil) ? code : "en"
    }

    /// HEXLANG (test / screenshot override, mirrors the web `?lang=`) -> device
    /// preferred language -> "en".
    public static func detectPreferredLocale() -> String {
        if let env = ProcessInfo.processInfo.environment["HEXLANG"], !env.isEmpty { return env }
        return Locale.preferredLanguages.first ?? "en"
    }

    // MARK: - Lookup

    /// Translate `key`, interpolating `{param}` tokens and selecting the plural
    /// form via `params["count"]`. Returns the key itself if it is absent from
    /// both the active locale and the `en` fallback (matches i18n.js).
    public func t(_ key: String, _ params: [String: Any] = [:]) -> String {
        guard let raw = lookup(key) else { return key }

        var value: String
        if let s = raw as? String {
            value = s
        } else if let forms = raw as? [String: Any] {
            let count = (params["count"] as? Int) ?? 1
            let category = Self.pluralCategory(locale: locale, count: count)
            value = (forms[category] as? String) ?? (forms["other"] as? String) ?? ""
        } else {
            return key
        }

        if !params.isEmpty {
            for (name, raw) in params {
                value = value.replacingOccurrences(of: "{\(name)}", with: "\(raw)")
            }
        }
        return value
    }

    /// Convenience for the call sites the web styles with `text-transform:
    /// uppercase` (lobby/results/pause buttons, scan label). Uppercases with the
    /// ACTIVE locale's case rules so Turkish maps i→İ exactly as the browser does
    /// under `lang="tr"` (a no-op for CJK scripts that have no case).
    public func tUpper(_ key: String, _ params: [String: Any] = [:]) -> String {
        t(key, params).uppercased(with: Locale(identifier: locale))
    }

    private func lookup(_ key: String) -> Any? {
        if let v = table[locale]?[key] { return v }
        if let v = table["en"]?[key] { return v }
        return nil
    }

    // MARK: - Plurals

    /// The CLDR plural category for the languages we ship. Covers the categories
    /// actually present in i18n.js: CJK (other only), Slavic (one/few/many/other
    /// for Russian), French/Portuguese (0 and 1 are "one"), and the default
    /// one/other. Unknown categories fall back to "other" in `t`.
    static func pluralCategory(locale: String, count: Int) -> String {
        switch locale {
        case "zh", "ja", "ko":
            return "other"
        case "ru":
            let mod10 = count % 10, mod100 = count % 100
            if mod10 == 1 && mod100 != 11 { return "one" }
            if (2...4).contains(mod10) && !(12...14).contains(mod100) { return "few" }
            return "many"
        case "fr", "pt":
            return count <= 1 ? "one" : "other"
        default:
            return count == 1 ? "one" : "other"
        }
    }
}

/// Free-function shorthand mirroring the web `t(key, params)`. Reads the shared
/// instance (configured once at startup).
public func tr(_ key: String, _ params: [String: Any] = [:]) -> String {
    Localization.shared.t(key, params)
}

/// Uppercased shorthand for the strings the web renders with `text-transform:
/// uppercase` (see `Localization.tUpper`).
public func trUpper(_ key: String, _ params: [String: Any] = [:]) -> String {
    Localization.shared.tUpper(key, params)
}
