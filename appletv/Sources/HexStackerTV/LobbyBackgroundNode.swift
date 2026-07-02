import SpriteKit
import HexStackerKit

/// Falling translucent hex-piece silhouettes behind the lobby, ported from
/// public/shared/WelcomeBackground.js. Pieces drift down at size-dependent
/// speeds and recycle at the top. Driven by `tick(dt:)` from the scene.
final class LobbyBackgroundNode: SKNode {

    private let poolSize = 16
    private var sceneSize: CGSize = .zero
    private var nodes: [SKNode] = []
    private var speeds: [CGFloat] = []
    private let pieceTypes = Array(BoardNode.pieceShapes.keys)

    /// (Re)build the pool for a given scene size. No-op if size is unchanged.
    func configure(size: CGSize) {
        guard size != sceneSize, size.width > 0, size.height > 0 else { return }
        sceneSize = size
        removeAllChildren()
        nodes.removeAll(); speeds.removeAll()

        // Seed the pool spread across the screen (and above it) so pieces are
        // already in motion when the lobby appears.
        let cols = Int(ceil((Double(poolSize) * 1.5).squareRoot()))
        for i in 0..<poolSize {
            let (node, speed) = makePiece()
            let col = i % max(cols, 1)
            node.position = CGPoint(
                x: size.width * (CGFloat(col) + 0.5) / CGFloat(max(cols, 1)) + .random(in: -40...40),
                y: .random(in: 0...(size.height * 1.5)))
            addChild(node)
            nodes.append(node); speeds.append(speed)
        }
    }

    /// Advance the falling pieces by `dt` seconds (clamped by the caller).
    func tick(dt: CGFloat) {
        guard sceneSize.height > 0 else { return }
        for i in nodes.indices {
            let node = nodes[i]
            node.position.y -= speeds[i] * dt
            if node.position.y < -120 {
                node.removeFromParent()
                let (fresh, speed) = makePiece()
                fresh.position = CGPoint(x: .random(in: 0...sceneSize.width),
                                         y: sceneSize.height + .random(in: 40...160))
                addChild(fresh)
                nodes[i] = fresh; speeds[i] = speed
            }
        }
    }

    // MARK: - Piece construction

    /// rotateCW in axial coords: (q, r) -> (-r, q + r). Matches the engine.
    private func rotated(_ cells: [(q: Int, r: Int)], times: Int) -> [(q: Int, r: Int)] {
        var cur = cells
        for _ in 0..<times { cur = cur.map { (q: -$0.r, r: $0.q + $0.r) } }
        return cur
    }

    // Discrete circumradii so the shared stamp cache stays bounded (random
    // continuous sizes would spawn a texture per value).
    private static let sizes: [CGFloat] = [12, 16, 20, 24, 28, 32]

    private func makePiece() -> (SKNode, CGFloat) {
        let type = pieceTypes.randomElement() ?? "I3"
        let cells = rotated(BoardNode.pieceShapes[type] ?? [], times: Int.random(in: 0...5))
        let typeId = EngineConstants.pieceTypeToId[type] ?? 1
        let rgb = Theme.pieceColors[typeId] ?? RGB(255, 255, 255)
        let size = Self.sizes.randomElement() ?? 20      // hex circumradius
        let opacity = CGFloat.random(in: 0.14...0.22)
        let sqrt3 = CGFloat(3).squareRoot()
        // Gradient piece stamp (the same NORMAL recipe the game pieces use),
        // matching the web lobby's getHexStamp background pieces instead of flat
        // silhouettes. stampHeight = circumradius·√3, trimmed for a small cell gap.
        let tex = HexStampFactory.shared.stamp(tier: .normal, color: rgb, size: size * sqrt3 * 0.94)

        let container = SKNode()
        container.alpha = opacity
        for cell in cells {
            let q = CGFloat(cell.q), r = CGFloat(cell.r)
            let cx = size * 1.5 * q
            let cy = size * sqrt3 * (r + q / 2)
            let hex = SKSpriteNode(texture: tex)
            hex.position = CGPoint(x: cx, y: -cy)   // canvas Y-down -> SK Y-up
            container.addChild(hex)
        }
        // Speed: smaller pieces fall faster (WelcomeBackground formula).
        let speed = 15 + (32 - size) / 20 * 25
        return (container, speed)
    }
}
