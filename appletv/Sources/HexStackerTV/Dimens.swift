import SwiftUI

/// Viewport-relative sizing (Android Vp parity): the web chrome sizes with
/// CSS clamp(min, Xvh/vw/vmin, max), and the TV ports mirror those clamps so
/// every tier renders the same proportions at 1080p and 4K output.
struct Vp {
    let w: CGFloat
    let h: CGFloat

    init(size: CGSize) {
        w = max(size.width, 1)
        h = max(size.height, 1)
    }

    var vmin: CGFloat { min(w, h) }

    /// clamp(lo, pct·vh, hi) in points.
    func vh(_ lo: CGFloat, _ pct: CGFloat, _ hi: CGFloat) -> CGFloat {
        min(max(lo, h * pct / 100), hi)
    }

    /// clamp(lo, pct·vw, hi) in points.
    func vw(_ lo: CGFloat, _ pct: CGFloat, _ hi: CGFloat) -> CGFloat {
        min(max(lo, w * pct / 100), hi)
    }

    /// Shared CTA height (web .btn max(48, 7.5vh)): lobby START, the results /
    /// pause / reconnect CTAs and About's LICENSES all use this one value, so
    /// every action button on tvOS is a uniform height across screens.
    var actionButtonH: CGFloat { max(48, h * 0.075) }
}
