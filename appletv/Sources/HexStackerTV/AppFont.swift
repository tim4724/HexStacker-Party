import UIKit

/// The app's two type voices, mirroring theme.css:
///   - Orbitron (`--font-hud`): the scoreboard voice — HUD labels, timers, room
///     codes. Ships as the variable `Orbitron[wght].ttf`.
///   - Baloo 2 (`--font-brand`): the identity voice — the title lockup and
///     buttons. Ships as the variable `Baloo2[wght].ttf`.
/// Both register their named instances as PostScript names (Orbitron-Regular …
/// Orbitron-Black; Baloo2-Regular … Baloo2-ExtraBold). We pick the instance per
/// weight so the UI matches the web weights rather than rendering everything at
/// Regular. Each accessor falls back down the weight ramp, then to a system face
/// if the family is absent.
enum AppFont {
    enum Weight: String {
        case regular = "Regular", medium = "Medium", semibold = "SemiBold"
        case bold = "Bold", extrabold = "ExtraBold", black = "Black"
    }

    static func psName(_ weight: Weight) -> String {
        let order: [Weight] = [weight, .bold, .extrabold, .black, .semibold, .medium, .regular]
        for w in order {
            let candidate = "Orbitron-\(w.rawValue)"
            if UIFont(name: candidate, size: 20) != nil { return candidate }
        }
        if UIFont(name: "Orbitron", size: 20) != nil { return "Orbitron" }
        return "Menlo-Bold"
    }

    /// Baloo 2 counterpart of `psName`. Baloo 2 tops out at ExtraBold (no Black),
    /// so the ramp caps there before stepping down.
    static func balooName(_ weight: Weight) -> String {
        let order: [Weight] = [weight, .extrabold, .bold, .semibold, .medium, .regular]
        for w in order {
            let candidate = "Baloo2-\(w.rawValue)"
            if UIFont(name: candidate, size: 20) != nil { return candidate }
        }
        if UIFont(name: "Baloo 2", size: 20) != nil { return "Baloo 2" }
        return "Menlo-Bold"
    }

    /// Default for HUD labels / values / timer (web weight ~700).
    static let name = psName(.bold)
    /// Titles, KO, multi-clear popups, countdown (web weight 900).
    static let black = psName(.black)
    /// Player names (web weight 800).
    static let extraBold = psName(.extrabold)
    /// Wordmark subtitle (web weight 600).
    static let semibold = psName(.semibold)

    /// Brand voice (Baloo 2). Wordmark, player names, PAUSED / connection
    /// headings, level value (web weights 800/900 — 900 caps at ExtraBold).
    static let brandExtraBold = balooName(.extrabold)
    /// Brand voice (Baloo 2). Button labels, LEVEL heading, status lines,
    /// results names, scan/About labels (web weight 700).
    static let brandBold = balooName(.bold)
    /// Brand voice (Baloo 2). Wordmark subtitle "PARTY", Game Music label
    /// (web weight 600).
    static let brandSemibold = balooName(.semibold)
    /// Brand voice (Baloo 2). Back hints, license meta lines (web weight 400).
    static let brandRegular = balooName(.regular)
}
