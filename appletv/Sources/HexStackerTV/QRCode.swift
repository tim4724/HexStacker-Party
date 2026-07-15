import UIKit
import CoreImage
import CoreImage.CIFilterBuiltins

/// Generates a crisp QR code image for the controller join URL using CoreImage.
/// Matches the web display's EC level L. CoreImage adds its own quiet zone, so
/// the server's non-standard 1-module quiet zone is not replicated.
enum QRCode {
    // A CIContext is expensive to build (Apple: create as few as possible and
    // reuse them). One shared instance serves every QR render instead of
    // allocating a fresh context per call (lobby QR + each per-board rejoin QR).
    private static let ciContext = CIContext()

    // Recent renders, keyed by payload+size. buildLobby re-runs on every roster
    // change with an unchanged join URL, so without this each join/leave pays a
    // full CIFilter render + CGImage readback for an identical code. A small
    // dictionary (not a single entry): the lobby card now composites the BLANK
    // and the patterned card bitmaps together for the load fade, so two keys
    // repeat every recomposition. Main-thread only (every caller is the scene).
    private static var renderCache: [String: UIImage] = [:]

    private static func cached(_ key: String, make: () -> UIImage?) -> UIImage? {
        if let hit = renderCache[key] { return hit }
        guard let image = make() else { return nil }
        if renderCache.count > 8 { renderCache.removeAll() }   // tiny working set
        renderCache[key] = image
        return image
    }

    /// Black modules on WHITE (the raw generator output). Used where the code
    /// is drawn over its own opaque card (About, the per-board rejoin QR).
    static func image(for string: String, sidePixels: CGFloat = 600) -> UIImage? {
        render(string, sidePixels: sidePixels, transparent: false)
    }

    /// Black modules on CLEAR, for compositing onto an existing card as plain
    /// content. The lobby card needs this instead of blending a white-backed
    /// image: a `.blendMode(.multiply)` child must composite against the
    /// backdrop, so SwiftUI hoists it out of the entrance band's animating
    /// group and the pattern stops tracking the card's slide (it faded in at
    /// the settled position — user-visible bug).
    static func maskImage(for string: String, sidePixels: CGFloat = 600) -> UIImage? {
        render(string, sidePixels: sidePixels, transparent: true)
    }

    /// The lobby join card: white rounded card + black modules baked into ONE
    /// bitmap, drawn by a single Image view. Composed as Shape + overlay(Image),
    /// the bitmap pattern stayed pinned at its layout position while the vector
    /// card rode the entrance band's animated offset (measured frame-by-frame);
    /// a .drawingGroup() instead made the whole card skip the entrance fade and
    /// pop in at the tail. A lone Image layer animates like any other leaf (the
    /// title bitmap in the same stagger proves it). Empty payload = blank white
    /// card (the pre-room scaffold).
    static func cardImage(for string: String, side: CGFloat, cornerRadius: CGFloat, padding: CGFloat) -> UIImage {
        let key = "card|\(side)|\(cornerRadius)|\(padding)|\(string)"
        let image = cached(key) {
            UIGraphicsImageRenderer(size: CGSize(width: side, height: side)).image { ctx in
                let rect = CGRect(x: 0, y: 0, width: side, height: side)
                UIColor.white.setFill()
                UIBezierPath(roundedRect: rect, cornerRadius: cornerRadius).fill()
                if !string.isEmpty, let qr = maskImage(for: string) {
                    ctx.cgContext.interpolationQuality = .none   // hard module edges
                    qr.draw(in: rect.insetBy(dx: padding, dy: padding))
                }
            }
        }
        return image ?? UIImage()
    }

    private static func render(_ string: String, sidePixels: CGFloat, transparent: Bool) -> UIImage? {
        let key = "\(transparent ? "t" : "o")|\(sidePixels)|\(string)"
        return cached(key) { renderUncached(string, sidePixels: sidePixels, transparent: transparent) }
    }

    private static func renderUncached(_ string: String, sidePixels: CGFloat, transparent: Bool) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(string.utf8)
        filter.correctionLevel = "L"
        guard var output = filter.outputImage else { return nil }

        if transparent {
            // black-on-white → white-on-black → alpha mask → zero the RGB:
            // opaque BLACK modules, everything else fully transparent.
            let inverted = CIFilter.colorInvert()
            inverted.inputImage = output
            let masked = CIFilter.maskToAlpha()
            masked.inputImage = inverted.outputImage
            let blacked = CIFilter.colorMatrix()
            blacked.inputImage = masked.outputImage
            blacked.rVector = CIVector(x: 0, y: 0, z: 0, w: 0)
            blacked.gVector = CIVector(x: 0, y: 0, z: 0, w: 0)
            blacked.bVector = CIVector(x: 0, y: 0, z: 0, w: 0)
            blacked.aVector = CIVector(x: 0, y: 0, z: 0, w: 1)
            guard let out = blacked.outputImage else { return nil }
            output = out
        }

        // Scale the tiny module image up to the requested pixel size, nearest-neighbor.
        let scale = sidePixels / output.extent.width
        let scaled = output.transformed(by: CGAffineTransform(scaleX: scale, y: scale))

        guard let cg = ciContext.createCGImage(scaled, from: scaled.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}
