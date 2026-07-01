import Foundation

/// Resolves runtime assets bundled by the "Sync engine JS" build phase, which
/// copies the canonical engine `.js` and the music track into `engine/` inside
/// the app bundle (a folder reference).
enum AssetLocator {
    static var engineDirectory: URL {
        if let url = Bundle.main.resourceURL?.appendingPathComponent("engine"),
           FileManager.default.fileExists(atPath: url.path) {
            return url
        }
        return Bundle.main.bundleURL
    }

    static func url(name: String, ext: String) -> URL? {
        if let u = Bundle.main.url(forResource: name, withExtension: ext, subdirectory: "engine") {
            return u
        }
        return Bundle.main.url(forResource: name, withExtension: ext)
    }
}
