import SwiftUI

@main
struct HexStackerApp: App {
    var body: some Scene {
        WindowGroup {
            GameView()
                .ignoresSafeArea()
        }
    }
}

/// Hosts the SpriteKit display inside SwiftUI.
struct GameView: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> GameViewController { GameViewController() }
    func updateUIViewController(_ controller: GameViewController, context: Context) {}
}
