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

    // Last render, keyed by payload+size. buildLobby re-runs on every roster
    // change with an unchanged join URL, so without this each join/leave pays a
    // full CIFilter render + CGImage readback for an identical code. One entry is
    // enough: per-board rejoin QRs are one-shot renders, only the lobby repeats.
    // Main-thread only (every caller is the scene).
    private static var lastRender: (key: String, image: UIImage)?

    static func image(for string: String, sidePixels: CGFloat = 600) -> UIImage? {
        let key = "\(sidePixels)|\(string)"
        if let lastRender, lastRender.key == key { return lastRender.image }

        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(string.utf8)
        filter.correctionLevel = "L"
        guard let output = filter.outputImage else { return nil }

        // Scale the tiny module image up to the requested pixel size, nearest-neighbor.
        let scale = sidePixels / output.extent.width
        let scaled = output.transformed(by: CGAffineTransform(scaleX: scale, y: scale))

        guard let cg = ciContext.createCGImage(scaled, from: scaled.extent) else { return nil }
        let image = UIImage(cgImage: cg)
        lastRender = (key, image)
        return image
    }
}
