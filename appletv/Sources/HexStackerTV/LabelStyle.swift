import SpriteKit

extension SKLabelNode {
    /// Set text with an Orbitron weight, color, and letter-spacing. SKLabelNode
    /// has no native letter-spacing, so this routes through `attributedText`
    /// (which the web tracks out via CSS `letter-spacing`). `tracking` is in em
    /// of the font size (e.g. 0.15 == CSS 0.15em). Alignment modes still apply.
    func setStyledText(_ text: String, font: String, size: CGFloat, color: UIColor, tracking: CGFloat = 0) {
        let f = UIFont(name: font, size: size) ?? .systemFont(ofSize: size, weight: .bold)
        attributedText = NSAttributedString(string: text, attributes: [
            .font: f,
            .foregroundColor: color,
            .kern: size * tracking,
        ])
    }
}
