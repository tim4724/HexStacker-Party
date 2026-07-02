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

    static func image(for string: String, sidePixels: CGFloat = 600) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(string.utf8)
        filter.correctionLevel = "L"
        guard let output = filter.outputImage else { return nil }

        // Scale the tiny module image up to the requested pixel size, nearest-neighbor.
        let scale = sidePixels / output.extent.width
        let scaled = output.transformed(by: CGAffineTransform(scaleX: scale, y: scale))

        guard let cg = ciContext.createCGImage(scaled, from: scaled.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}
