import Foundation

/// Platform i18n for the native display: strings resolve from
/// Localizable.xcstrings, the committed mirror of public/shared/i18n.js.
/// tests/i18n-appletv-parity.test.js keeps the catalog in lockstep with the
/// web table (the same guard the Android port has for res/values-*/strings.xml),
/// so the TV copy still cannot drift from the web wording. Foundation owns what
/// the web gets from t() + Intl.PluralRules: locale matching, EN fallback, and
/// CLDR plural selection (the catalog compiles to .strings/.stringsdict).

/// The language the bundle actually resolved (e.g. "de" when the UI is German,
/// "en" after a fallback) — primary subtag, lowercased, mirroring i18n.js
/// setLocale. Drives locale-sensitive behavior outside string lookup: trUpper
/// casing and the About overlay's legal-page routing.
var resolvedLocale: String {
    let preferred = Bundle.main.preferredLocalizations.first ?? "en"
    let primary = preferred.split(whereSeparator: { $0 == "-" || $0 == "_" }).first
    return primary.map { $0.lowercased() } ?? "en"
}

/// Mirror of the web `t(key, params)`. A key absent from the catalog renders
/// as the key itself, exactly like the web t(). Args are positional (%1$d…);
/// a plural key picks its CLDR form from the count argument.
func tr(_ key: String, _ args: CVarArg...) -> String {
    resolve(key, args)
}

/// Uppercased with the RESOLVED locale's case rules (Turkish i→İ), matching
/// the web's `text-transform: uppercase` under `lang=<locale>`. Deliberately
/// not Locale.current: after an EN fallback the strings are English and must
/// case as English, whatever the device locale is.
func trUpper(_ key: String, _ args: CVarArg...) -> String {
    resolve(key, args).uppercased(with: Locale(identifier: resolvedLocale))
}

private func resolve(_ key: String, _ args: [CVarArg]) -> String {
    let format = Bundle.main.localizedString(forKey: key, value: nil, table: nil)
    return args.isEmpty ? format : String(format: format, locale: Locale.current, arguments: args)
}
