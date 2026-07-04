import SpriteKit
import HexStackerKit

/// About overlay for the tvOS display, opened from the lobby ⓘ button. Shows two QR
/// cards — Privacy and Imprint — linking a phone to the web legal pages, plus a
/// focusable "Open Source Licenses" button that drills into LicensesOverlay. Menu
/// returns to the lobby.
///
/// The game is played on phones, so the phone the player is already holding is the
/// right screen for long-form legal text: this only offers a scan target + the URL,
/// and the pages stay single-sourced on the web (not re-rendered natively). The card
/// labels reuse the web i18n `privacy` / `imprint` strings via `tr()`, so no copy is
/// TV-invented; the sole `Open Source Licenses` button, like LicensesOverlay, is the
/// one English-only piece of TV chrome the web has no equivalent for.
///
/// Input model mirrors LicensesOverlay: while open, RootScene routes the remote here
/// via the `isOpen` flag rather than the shared focus-menu grid. The single button is
/// always shown focused, so Select activates it and Menu closes the overlay.
final class AboutOverlay {

    // The web legal pages the QR codes encode.
    private static let privacyURL = "https://hexstacker.com/privacy"
    private static let imprintURL = "https://hexstacker.com/imprint"

    let node = SKNode()
    private(set) var isOpen = false
    private var built = false

    /// Set by RootScene: opens the Open Source Licenses overlay on top of this one.
    var onOpenLicenses: (() -> Void)?

    init() {
        node.zPosition = 135   // above connection (130); below licenses (140), which drills in on top
        node.isHidden = true
    }

    /// Build the (static) overlay once the scene has its size + safe area. Cheap to
    /// rebuild on a resize; `built` guards the common no-op re-entry.
    func configure(size: CGSize, playRect: CGRect) {
        guard !built || node.parent == nil else { return }
        built = true
        node.removeAllChildren()

        // Opaque brand background — this replaces the lobby while open (matches the
        // Android full-screen swap and LicensesOverlay).
        let bg = SKSpriteNode(color: UIColor(Theme.bgPrimary), size: size)
        bg.position = CGPoint(x: size.width / 2, y: size.height / 2)
        bg.zPosition = 0
        node.addChild(bg)

        let margin = playRect.height * 0.05

        // Back hint at the top (English-only chrome, like LicensesOverlay's hint).
        let hint = SKLabelNode()
        hint.horizontalAlignmentMode = .center
        hint.verticalAlignmentMode = .top
        hint.setStyledText("Press Menu to return", font: AppFont.psName(.regular),
                           size: max(14, min(playRect.height * 0.02, 20)),
                           color: SKTheme.textFaint, tracking: 0.02)
        hint.position = CGPoint(x: playRect.midX, y: playRect.maxY - margin)
        hint.zPosition = 1
        node.addChild(hint)

        // Privacy / Imprint QR cards + the "Open Source Licenses" button as one
        // vertically centered cluster (matches the Android About layout), rather than
        // the button pinned to the bottom edge with the cards floating above.
        let cardW = min(playRect.width * 0.28, 320)
        let cardH = legalCardHeight(cardW)
        let btnH = max(48, playRect.height * 0.075)
        let clusterGap = playRect.height * 0.06
        let clusterH = cardH + clusterGap + btnH
        let cardsCenterY = playRect.midY + clusterH / 2 - cardH / 2
        let btnCenterY = playRect.midY - clusterH / 2 + btnH / 2

        let gap = min(playRect.width * 0.06, 96)
        let rowW = cardW * 2 + gap
        node.addChild(buildLegalCard(label: trUpper("privacy"), url: Self.privacyURL, width: cardW,
                                     center: CGPoint(x: playRect.midX - rowW / 2 + cardW / 2, y: cardsCenterY)))
        node.addChild(buildLegalCard(label: trUpper("imprint"), url: Self.imprintURL, width: cardW,
                                     center: CGPoint(x: playRect.midX + rowW / 2 - cardW / 2, y: cardsCenterY)))

        // "Open Source Licenses" button below the cards, always shown focused — the
        // only actionable item while About is open (RootScene calls activate()).
        let btnText = "Open Source Licenses"
        let probe = SKLabelNode()
        probe.setStyledText(btnText, font: AppFont.name, size: btnH * 0.36, color: .white, tracking: 0.08)
        let btnW = probe.frame.width + min(playRect.width * 0.04, 96) * 2
        let button = MenuButton(text: btnText, width: btnW, height: btnH, primary: false,
                                tint: SKTheme.accentPrimary) { [weak self] in self?.onOpenLicenses?() }
        button.position = CGPoint(x: playRect.midX, y: btnCenterY)
        button.zPosition = 1
        button.setFocused(true)
        node.addChild(button)
    }

    /// Total card height for a given width (label + QR square + URL, plus padding),
    /// used both to lay a card out and to size the centered cluster.
    private func legalCardHeight(_ w: CGFloat) -> CGFloat {
        let pad = w * 0.07, labelH = w * 0.13, urlH = w * 0.1, gap = w * 0.05
        let qrSide = w - pad * 2
        return pad + labelH + gap + qrSide + gap + urlH + pad
    }

    /// A single About QR card: label (Privacy / Imprint), the QR encoding `url` on a
    /// white panel, and the URL text below. Display-only — a phone scans it.
    private func buildLegalCard(label: String, url: String, width w: CGFloat, center: CGPoint) -> SKNode {
        let node = SKNode()
        node.position = center

        let pad = w * 0.07
        let labelH = w * 0.13
        let urlH = w * 0.1
        let gap = w * 0.05
        let qrSide = w - pad * 2
        let h = legalCardHeight(w)

        let card = SKShapeNode(path: roundedRect(CGRect(x: -w / 2, y: -h / 2, width: w, height: h), radius: w * 0.09))
        card.fillColor = SKTheme.bgCard
        card.strokeColor = SKTheme.border
        card.lineWidth = 1
        node.addChild(card)

        let labelNode = SKLabelNode()
        labelNode.verticalAlignmentMode = .center
        labelNode.horizontalAlignmentMode = .center
        labelNode.zPosition = 1
        labelNode.setStyledText(label, font: AppFont.name, size: labelH * 0.58,
                                color: SKTheme.textPrimary(), tracking: 0.12)
        labelNode.position = CGPoint(x: 0, y: h / 2 - pad - labelH / 2)
        node.addChild(labelNode)

        let qrCenterY = h / 2 - pad - labelH - gap - qrSide / 2
        let qrBg = SKShapeNode(path: roundedRect(
            CGRect(x: -qrSide / 2, y: qrCenterY - qrSide / 2, width: qrSide, height: qrSide), radius: w * 0.05))
        qrBg.fillColor = .white
        qrBg.strokeColor = .clear
        node.addChild(qrBg)
        if let qr = QRCode.image(for: url) {
            let sprite = SKSpriteNode(texture: SKTexture(image: qr))
            let inset = qrSide * 0.92
            sprite.size = CGSize(width: inset, height: inset)
            sprite.position = CGPoint(x: 0, y: qrCenterY)
            sprite.zPosition = 1
            node.addChild(sprite)
        }

        let urlNode = SKLabelNode()
        urlNode.verticalAlignmentMode = .center
        urlNode.horizontalAlignmentMode = .center
        urlNode.zPosition = 1
        urlNode.setStyledText(url.replacingOccurrences(of: "https://", with: ""),
                              font: AppFont.semibold, size: urlH * 0.6,
                              color: SKTheme.textSecondary, tracking: 0.02)
        urlNode.position = CGPoint(x: 0, y: -h / 2 + pad + urlH / 2)
        node.addChild(urlNode)

        return node
    }

    private func roundedRect(_ rect: CGRect, radius: CGFloat) -> CGPath {
        UIBezierPath(roundedRect: rect, cornerRadius: radius).cgPath
    }

    func open() {
        node.isHidden = false
        isOpen = true
    }

    func close() {
        node.isHidden = true
        isOpen = false
    }

    /// Select while open: drill into the Open Source Licenses overlay.
    func activate() { onOpenLicenses?() }
}
