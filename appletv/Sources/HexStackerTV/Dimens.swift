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

    /// Full-screen basis from a root GeometryReader: geo.size plus the
    /// safe-area insets (the tvOS simulator reports 60/80pt overscan). The web
    /// reference renders its clamp() sizes against the whole 1080p viewport
    /// and the SpriteKit boards are full-bleed, so chrome sizes must scale
    /// against the same height or they read ~11% smaller than both; layout
    /// still happens inside the title-safe geo.
    init(fullScreenOf geo: GeometryProxy) {
        self.init(size: CGSize(
            width: geo.size.width + geo.safeAreaInsets.leading + geo.safeAreaInsets.trailing,
            height: geo.size.height + geo.safeAreaInsets.top + geo.safeAreaInsets.bottom))
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
