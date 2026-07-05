import SpriteKit
import HexStackerKit

/// The host's "Game Music" on/off control (the display-side mute), surfaced in
/// the pause overlay as a full-width settings row: label on the left, switch on
/// the right (web settings-row pattern). The row spans the same width as the
/// action buttons below it, so its focus frame is proportional to them (rather
/// than a big highlight around a tiny cluster). The switch mirrors the web
/// `.settings-switch`: a 52:30 pill, white thumb, ON tinted by the host's player
/// color, OFF a faint translucent white. On = music playing.
final class MusicSwitch: SKNode, Focusable {
    let enabled = true
    let action: () -> Void

    private var isOn: Bool
    private let onColor: UIColor
    private let ring = SKShapeNode()      // focus frame at the row bounds
    private let label = SKLabelNode()
    private let track = SKSpriteNode()
    private let knob = SKSpriteNode()
    private var knobOffX: CGFloat = 0
    private var knobOnX: CGFloat = 0

    init(width w: CGFloat, height h: CGFloat, isOn: Bool, tint: UIColor, action: @escaping () -> Void) {
        self.isOn = isOn
        self.onColor = tint
        self.action = action
        // Web .settings-switch geometry: 52x30 track, 24px thumb, 3px inset.
        let trackH = h * 0.46
        let trackW = trackH * (52.0 / 30.0)
        let knobR = trackH * (24.0 / 30.0) / 2
        let margin = trackH * (3.0 / 30.0)
        super.init()

        // Focus frame at the row's exact bounds (matches MenuButton focus).
        ring.path = UIBezierPath(roundedRect: CGRect(x: -w / 2, y: -h / 2, width: w, height: h),
                                 cornerRadius: 12).cgPath
        ring.fillColor = .clear
        ring.strokeColor = .clear
        ring.isAntialiased = true
        ring.zPosition = 0
        addChild(ring)

        // Label + switch sit as a centered pair inside the full-width focus row,
        // rather than pinned to opposite edges (which reads as too wide a gap at the
        // button-pair row width on a TV). Measure the label to center the pair.
        label.verticalAlignmentMode = .center
        label.horizontalAlignmentMode = .left
        label.zPosition = 2
        label.setStyledText(tr("settings_game_music"), font: AppFont.brandSemibold, size: h * 0.40,
                            color: SKTheme.textPrimary(), tracking: 0.05)
        let labelW = label.calculateAccumulatedFrame().width
        let pairGap = h * 0.5   // gap between the label and the switch
        let groupW = labelW + pairGap + trackW
        let labelX = -groupW / 2
        label.position = CGPoint(x: labelX, y: 0)
        addChild(label)

        // Switch, immediately to the right of the label. The pill and knob are
        // baked into textures (Core Graphics gives crisp, coverage-antialiased
        // edges) rather than drawn as live SKShapeNode fills, which render pixely
        // at this small size. Same texture-bake pattern as MenuButton.
        let trackCenterX = labelX + labelW + pairGap + trackW / 2
        track.texture = Self.bakePill(width: trackW, height: trackH)
        track.size = CGSize(width: trackW, height: trackH)
        track.colorBlendFactor = 1   // tint the white pill via updateVisual()
        track.position = CGPoint(x: trackCenterX, y: 0)
        track.zPosition = 1
        addChild(track)

        knob.texture = Self.bakeDisc(radius: knobR)
        knob.size = CGSize(width: knobR * 2, height: knobR * 2)
        knob.zPosition = 2
        addChild(knob)

        knobOffX = trackCenterX - trackW / 2 + margin + knobR
        knobOnX = trackCenterX + trackW / 2 - margin - knobR

        updateVisual()
        setFocused(false)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    func activate() { action() }

    func setOn(_ on: Bool) { isOn = on; updateVisual() }

    func setFocused(_ focused: Bool) {
        ring.fillColor = focused ? UIColor(white: 1, alpha: 0.06) : .clear
        ring.strokeColor = focused ? .white : .clear
        ring.lineWidth = focused ? 4 : 0
        setScale(focused ? 1.03 : 1.0)
    }

    private func updateVisual() {
        // web ON=player-color, OFF=rgba(255,255,255,.12). Tint the white pill
        // texture: ON = onColor opaque, OFF = white at 0.12 alpha.
        track.color = isOn ? onColor : .white
        track.alpha = isOn ? 1.0 : 0.12
        knob.position = CGPoint(x: isOn ? knobOnX : knobOffX, y: 0)
    }

    /// A white, rounded pill baked at device scale for crisp edges.
    private static func bakePill(width: CGFloat, height: CGFloat) -> SKTexture {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: width, height: height))
        let image = renderer.image { rctx in
            let ctx = rctx.cgContext
            ctx.addPath(UIBezierPath(roundedRect: CGRect(x: 0, y: 0, width: width, height: height),
                                     cornerRadius: height / 2).cgPath)
            ctx.setFillColor(UIColor.white.cgColor)
            ctx.fillPath()
        }
        return SKTexture(image: image)
    }

    /// A white filled disc baked at device scale for crisp edges.
    private static func bakeDisc(radius: CGFloat) -> SKTexture {
        let d = radius * 2
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: d, height: d))
        let image = renderer.image { rctx in
            let ctx = rctx.cgContext
            ctx.addPath(UIBezierPath(ovalIn: CGRect(x: 0, y: 0, width: d, height: d)).cgPath)
            ctx.setFillColor(UIColor.white.cgColor)
            ctx.fillPath()
        }
        return SKTexture(image: image)
    }
}
