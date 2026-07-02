import UIKit

/// The display font. Orbitron ships as the variable `Orbitron[wght].ttf`, which
/// tvOS registers with its named instances exposed as PostScript names
/// (Orbitron-Regular ... Orbitron-Black). We pick the instance per weight so the
/// UI matches the web's bold Orbitron rather than rendering everything at Regular.
/// Falls back down the weight ramp, then to a system face if Orbitron is absent.
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

    /// Default for HUD labels / values / timer (web weight ~700).
    static let name = psName(.bold)
    /// Titles, KO, multi-clear popups, countdown (web weight 900).
    static let black = psName(.black)
    /// Player names (web weight 800).
    static let extraBold = psName(.extrabold)
    /// Wordmark subtitle (web weight 600).
    static let semibold = psName(.semibold)
}
