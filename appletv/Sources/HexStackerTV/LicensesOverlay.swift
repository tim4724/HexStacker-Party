import SpriteKit
import HexStackerKit

/// Full-screen "Licenses" overlay for the tvOS display, reached from the lobby
/// footer link. Lists the third-party components the app actually bundles,
/// one focusable row per component (mirroring the Android LicensesScreen): the
/// Siri Remote d-pad (Up/Down) moves focus, Select toggles the full license text
/// open in place, and Menu returns to the lobby. The list scrolls as needed to
/// keep the focused row visible.
///
/// The list is short by design: unlike Android (which bundles the whole AndroidX /
/// Compose Apache stack), the tvOS app runs on Apple system frameworks
/// (JavaScriptCore, SpriteKit, SwiftUI, Foundation) which are Apple-provided and
/// need no attribution. What DOES ship third-party is the WebRTC binary (BSD-3),
/// the Orbitron and Baloo 2 fonts (OFL 1.1), and the lobby music (CC BY 3.0).
///
/// English-only, like the Android screen: this is TV-only chrome the web has no
/// equivalent for, so there is no shared i18n.js string to mirror via `tr()`.
final class LicensesOverlay {

    let node = SKNode()
    private(set) var isOpen = false

    private let crop = SKCropNode()
    private let content = SKNode()
    private var contentTopY: CGFloat = 0   // scene y of the content's top row at scrollY 0
    private var scrollY: CGFloat = 0
    private var maxScroll: CGFloat = 0
    private var viewportHeight: CGFloat = 0
    private var built = false

    // Fold/expand state (mirrors the Android LicenseRow): rows collapse to their
    // header (name / license / author) and Select expands the body in place.
    // Row geometry is content-local (top y ≤ 0, descending) and rebuilt with the
    // content whenever an expansion changes the stack heights.
    private var focusIndex = 0
    private var expanded: Set<Int> = []
    private var rowCards: [SKShapeNode] = []
    private var rowRings: [SKShapeNode] = []
    private var rowTops: [CGFloat] = []
    private var rowHeights: [CGFloat] = []
    private var contentWidth: CGFloat = 0
    private var contentLeftX: CGFloat = 0

    private struct Entry {
        let name: String
        let author: String
        let license: String
        let body: String
    }

    init() {
        node.zPosition = 140   // above connection (130), pause (90), countdown (80)
        node.isHidden = true
    }

    /// Build the (static) overlay once the scene has its size + safe area. Cheap to
    /// rebuild on a resize; `built` guards the common no-op re-entry.
    func configure(size: CGSize, playRect: CGRect) {
        guard !built || node.parent == nil else { return }
        built = true
        node.removeAllChildren()

        // Opaque brand background — this replaces the lobby while open, so d-pad
        // focus behind it is never visible (matches the Android full-screen swap).
        let bg = SKSpriteNode(color: UIColor(Theme.bgPrimary), size: size)
        bg.position = CGPoint(x: size.width / 2, y: size.height / 2)
        bg.zPosition = 0
        node.addChild(bg)

        let margin = playRect.height * 0.05
        let titleSize = max(30, min(playRect.height * 0.05, 52))

        let title = SKLabelNode()
        title.horizontalAlignmentMode = .left
        title.verticalAlignmentMode = .top
        title.setStyledText("Licenses", font: AppFont.brandExtraBold,
                            size: titleSize, color: SKTheme.textPrimary(), tracking: 0.08)
        title.position = CGPoint(x: playRect.minX, y: playRect.maxY - margin)
        title.zPosition = 1
        node.addChild(title)

        let hint = SKLabelNode()
        hint.horizontalAlignmentMode = .left
        hint.verticalAlignmentMode = .top
        hint.setStyledText("Press Menu to return", font: AppFont.brandRegular,
                           size: max(22, min(playRect.height * 0.033, 32)),
                           color: SKTheme.textFaint, tracking: 0.02)
        hint.position = CGPoint(x: playRect.minX, y: title.position.y - title.frame.height - margin * 0.3)
        hint.zPosition = 1
        node.addChild(hint)

        // Scroll viewport: from below the hint down to the bottom safe edge.
        let viewportTop = hint.position.y - hint.frame.height - margin * 0.5
        let viewportBottom = playRect.minY + margin
        viewportHeight = viewportTop - viewportBottom
        contentTopY = viewportTop

        let mask = SKSpriteNode(color: .white,
                                size: CGSize(width: playRect.width, height: viewportHeight))
        mask.position = CGPoint(x: playRect.midX, y: (viewportTop + viewportBottom) / 2)
        crop.maskNode = mask
        crop.zPosition = 1
        node.addChild(crop)

        crop.addChild(content)
        contentWidth = playRect.width
        contentLeftX = playRect.minX
        rebuildContent()
    }

    /// Rebuild the row stack for the current fold/expand state and refresh the
    /// scroll extent (expansions change the stack heights).
    private func rebuildContent() {
        let contentHeight = buildContent(width: contentWidth, leftX: contentLeftX)
        maxScroll = max(0, contentHeight - viewportHeight)
    }

    /// Lay the attributions out top-to-bottom as cards, matching the Android licenses
    /// list: each entry is a rounded card (name left, license right, author subtitle),
    /// with the full license text below only while expanded. Content-local y starts at
    /// 0 and descends; returns the total stack height for the scroll extent.
    private func buildContent(width: CGFloat, leftX: CGFloat) -> CGFloat {
        content.removeAllChildren()
        rowCards.removeAll()
        rowRings.removeAll()
        rowTops.removeAll()
        rowHeights.removeAll()
        var y: CGFloat = 0
        let cardGap = width * 0.016
        let padX = width * 0.022
        let padY = width * 0.016
        let innerW = width - padX * 2
        let radius: CGFloat = 12   // var(--radius-md), matching MenuButton / the Android rows

        for (i, e) in Self.entries.enumerated() {
            if i > 0 { y -= cardGap }
            let cardTop = y
            var inner = cardTop - padY

            // Header row: component name (left) + license name (right).
            let name = SKLabelNode()
            name.horizontalAlignmentMode = .left
            name.verticalAlignmentMode = .top
            name.zPosition = 1
            name.setStyledText(e.name, font: AppFont.brandBold, size: max(18, min(width * 0.015, 28)),
                               color: SKTheme.textPrimary(), tracking: 0.02)
            name.position = CGPoint(x: leftX + padX, y: inner)
            content.addChild(name)

            let license = SKLabelNode()
            license.horizontalAlignmentMode = .right
            license.verticalAlignmentMode = .top
            license.zPosition = 1
            license.setStyledText(e.license, font: AppFont.brandRegular, size: max(13, min(width * 0.011, 20)),
                                  color: SKTheme.textSecondary, tracking: 0.02)
            license.position = CGPoint(x: leftX + width - padX, y: inner)
            content.addChild(license)

            inner -= name.frame.height + padY * 0.4

            let author = SKLabelNode()
            author.horizontalAlignmentMode = .left
            author.verticalAlignmentMode = .top
            author.zPosition = 1
            author.setStyledText(e.author, font: AppFont.brandRegular, size: max(12, min(width * 0.0095, 18)),
                                 color: SKTheme.textFaint, tracking: 0.02)
            author.position = CGPoint(x: leftX + padX, y: inner)
            content.addChild(author)
            inner -= author.frame.height

            if expanded.contains(i) {
                inner -= padY * 0.7
                let body = multilineLabel(e.body, width: innerW)
                body.zPosition = 1
                body.position = CGPoint(x: leftX + padX, y: inner)
                content.addChild(body)
                inner -= body.frame.height
            }

            // Card background sized to the accumulated content, drawn behind it.
            let cardBottom = inner - padY
            let h = cardTop - cardBottom
            let card = SKShapeNode(path: CGPath(roundedRect: CGRect(x: leftX, y: cardBottom, width: width,
                                                                    height: h),
                                                cornerWidth: radius, cornerHeight: radius, transform: nil))
            card.zPosition = 0
            content.addChild(card)

            // Focus ring on its own inset path: SKShapeNode strokes straddle the
            // path, so a ring on the card edge pokes half its width outside the
            // card — the scroll viewport would crop it on the first/last row.
            // Inset by half the stroke it stays inside the card bounds, matching
            // Compose's border (which always draws inside the shape) on Android.
            let ringInset: CGFloat = 2
            let ring = SKShapeNode(path: CGPath(
                roundedRect: CGRect(x: leftX + ringInset, y: cardBottom + ringInset,
                                    width: width - ringInset * 2, height: h - ringInset * 2),
                cornerWidth: radius - ringInset, cornerHeight: radius - ringInset, transform: nil))
            ring.fillColor = .clear
            ring.lineWidth = 4
            ring.isAntialiased = true
            ring.zPosition = 2
            content.addChild(ring)

            rowCards.append(card)
            rowRings.append(ring)
            rowTops.append(cardTop)
            rowHeights.append(h)
            styleCard(i)

            y = cardBottom
        }
        return -y
    }

    /// Focus visuals follow the game-UI convention (MenuButton / MusicSwitch, and the
    /// Android rows): 4px white ring + 6% white wash; unfocused rows are the plain
    /// secondary card with a 1px hairline.
    private func styleCard(_ i: Int) {
        guard rowCards.indices.contains(i) else { return }
        let focused = i == focusIndex
        rowCards[i].fillColor = focused ? Self.focusFill : SKTheme.bgSecondary
        rowCards[i].strokeColor = focused ? .clear : SKTheme.border
        rowCards[i].lineWidth = 1
        rowRings[i].strokeColor = focused ? .white : .clear
    }

    /// The MusicSwitch focus wash (6% white over the fill), precomputed because
    /// SKShapeNode has a single flat fill rather than stacked layers.
    private static let focusFill: UIColor = {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        SKTheme.bgSecondary.getRed(&r, green: &g, blue: &b, alpha: &a)
        let mix: (CGFloat) -> CGFloat = { $0 + (1 - $0) * 0.06 }
        return UIColor(red: mix(r), green: mix(g), blue: mix(b), alpha: a)
    }()

    /// A left-aligned, top-anchored monospace paragraph. License text is
    /// pre-wrapped, so `numberOfLines = 0` just honours the embedded newlines; the
    /// wide `preferredMaxLayoutWidth` guards the rare over-long line.
    private func multilineLabel(_ text: String, width: CGFloat) -> SKLabelNode {
        let label = SKLabelNode()
        label.horizontalAlignmentMode = .left
        label.verticalAlignmentMode = .top
        label.numberOfLines = 0
        label.preferredMaxLayoutWidth = width
        let size: CGFloat = 20
        let mono = UIFont(name: "Menlo", size: size) ?? .monospacedSystemFont(ofSize: size, weight: .regular)
        label.attributedText = NSAttributedString(string: text, attributes: [
            .font: mono,
            .foregroundColor: SKTheme.textSecondary,
        ])
        return label
    }

    /// Open at the top with everything folded and the first row focused (matches
    /// the Android screen seating focus on the first row on entry).
    func open() {
        node.isHidden = false
        isOpen = true
        focusIndex = 0
        if !expanded.isEmpty {
            expanded = []
            rebuildContent()
        } else {
            for i in rowCards.indices { styleCard(i) }
        }
        setScroll(0)
    }

    func close() {
        node.isHidden = true
        isOpen = false
    }

    /// D-pad Up/Down: move focus one row (clamped, like the Android list — no wrap)
    /// and scroll just enough to keep the focused row visible. A focused row taller
    /// than the viewport (an expanded license body) scrolls in place instead, so the
    /// whole text is readable; focus leaves it only once its far edge is on screen.
    func moveFocus(_ delta: Int) {
        guard isOpen, !rowCards.isEmpty else { return }
        if scrollWithinFocused(delta) { return }
        let target = min(max(0, focusIndex + delta), rowCards.count - 1)
        guard target != focusIndex else { return }
        let previous = focusIndex
        focusIndex = target
        styleCard(previous)
        styleCard(target)
        ensureFocusedVisible(entering: delta)
    }

    /// Half-viewport step through a focused row that overflows the viewport, clamped
    /// so the last step lands its far edge exactly on the viewport edge. Returns
    /// false once there is nothing left to reveal in `delta`'s direction (or the row
    /// fits), letting the press move focus instead.
    private func scrollWithinFocused(_ delta: Int) -> Bool {
        guard rowHeights.indices.contains(focusIndex), rowHeights[focusIndex] > viewportHeight else { return false }
        let top = rowTops[focusIndex]                       // content-local, ≤ 0
        let bottom = top - rowHeights[focusIndex]
        let step = viewportHeight * 0.5
        if delta > 0 {
            let bottomAligned = -bottom - viewportHeight    // scrollY showing the row's bottom
            guard scrollY < bottomAligned - 0.5 else { return false }
            setScroll(min(scrollY + step, bottomAligned))
        } else {
            let topAligned = -top                           // scrollY showing the row's top
            guard scrollY > topAligned + 0.5 else { return false }
            setScroll(max(scrollY - step, topAligned))
        }
        return true
    }

    /// Select: toggle the focused row's license body open/closed in place.
    func toggleFocused() {
        guard isOpen, rowCards.indices.contains(focusIndex) else { return }
        if expanded.contains(focusIndex) {
            expanded.remove(focusIndex)
        } else {
            expanded.insert(focusIndex)
        }
        rebuildContent()
        ensureFocusedVisible()
    }

    /// Scroll so the focused row is fully on screen. A row taller than the viewport
    /// (an expanded license body) shows its nearest edge instead — the top when focus
    /// entered from above (`entering` ≥ 0), the bottom when it entered from below —
    /// so scrollWithinFocused then walks through the rest.
    private func ensureFocusedVisible(entering: Int = 1) {
        guard rowTops.indices.contains(focusIndex) else { return }
        let top = rowTops[focusIndex]                       // content-local, ≤ 0
        let bottom = top - rowHeights[focusIndex]
        var target = scrollY
        if rowHeights[focusIndex] >= viewportHeight {
            target = entering >= 0 ? -top : -bottom - viewportHeight
        } else {
            if target > -top { target = -top }                                   // row above the viewport
            if target < -bottom - viewportHeight { target = -bottom - viewportHeight }  // row below it
        }
        setScroll(target)
    }

    private func setScroll(_ y: CGFloat) {
        scrollY = min(max(0, y), maxScroll)
        content.position = CGPoint(x: 0, y: contentTopY + scrollY)
    }

    // MARK: - Attribution data (English-only license text, embedded verbatim)

    // Music and font lead the list (the app's most audible/visible credits); the
    // WebRTC binary attribution follows.
    private static let entries: [Entry] = [
        Entry(
            name: "Lunar Joyride",
            author: "FoxSynergy",
            license: "CC BY 3.0",
            body: """
            "Lunar Joyride" by FoxSynergy
            Licensed under Creative Commons Attribution 3.0 Unported (CC BY 3.0)
            https://creativecommons.org/licenses/by/3.0/
            """),
        // Fonts alphabetically, matching the Android assembleLicenseList order.
        Entry(
            name: "Baloo 2",
            author: "Ek Type",
            license: "SIL Open Font License 1.1",
            body: balooOFL),
        Entry(
            name: "Orbitron",
            author: "The Orbitron Project Authors",
            license: "SIL Open Font License 1.1",
            body: orbitronOFL),
        Entry(
            name: "WebRTC",
            author: "The WebRTC project authors, Google Inc.",
            license: "BSD-3-Clause",
            body: bsd3Clause),
    ]

    private static let bsd3Clause = """
    Copyright (c) 2011, The WebRTC project authors. All rights reserved.
    Copyright (c) 2011, Google Inc. All rights reserved.

    Redistribution and use in source and binary forms, with or without
    modification, are permitted provided that the following conditions are
    met:

      * Redistributions of source code must retain the above copyright
        notice, this list of conditions and the following disclaimer.

      * Redistributions in binary form must reproduce the above copyright
        notice, this list of conditions and the following disclaimer in
        the documentation and/or other materials provided with the
        distribution.

      * Neither the name of Google nor the names of its contributors may
        be used to endorse or promote products derived from this software
        without specific prior written permission.

    THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
    "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
    LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
    A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
    HOLDERS OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
    SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
    LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
    DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
    THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
    (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
    OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
    """

    // SIL Open Font License 1.1 (verbatim), parameterised by each font's copyright
    // header. Both bundled fonts ship under OFL 1.1 with identical body text.
    private static let orbitronOFL = ofl11(copyright:
        "Copyright 2018 The Orbitron Project Authors (https://github.com/theleagueof/orbitron), with Reserved Font Name: \"Orbitron\"")
    private static let balooOFL = ofl11(copyright:
        "Copyright 2019 The Baloo 2 Project Authors (https://github.com/EkType/Baloo2)")

    private static func ofl11(copyright: String) -> String {
    """
    \(copyright)

    This Font Software is licensed under the SIL Open Font License, Version 1.1.
    This license is copied below, and is also available with a FAQ at:
    http://scripts.sil.org/OFL

    -----------------------------------------------------------
    SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
    -----------------------------------------------------------

    PREAMBLE
    The goals of the Open Font License (OFL) are to stimulate worldwide
    development of collaborative font projects, to support the font creation
    efforts of academic and linguistic communities, and to provide a free and
    open framework in which fonts may be shared and improved in partnership
    with others.

    The OFL allows the licensed fonts to be used, studied, modified and
    redistributed freely as long as they are not sold by themselves. The
    fonts, including any derivative works, can be bundled, embedded,
    redistributed and/or sold with any software provided that any reserved
    names are not used by derivative works. The fonts and derivatives,
    however, cannot be released under any other type of license. The
    requirement for fonts to remain under this license does not apply
    to any document created using the fonts or their derivatives.

    DEFINITIONS
    "Font Software" refers to the set of files released by the Copyright
    Holder(s) under this license and clearly marked as such. This may
    include source files, build scripts and documentation.

    "Reserved Font Name" refers to any names specified as such after the
    copyright statement(s).

    "Original Version" refers to the collection of Font Software components as
    distributed by the Copyright Holder(s).

    "Modified Version" refers to any derivative made by adding to, deleting,
    or substituting -- in part or in whole -- any of the components of the
    Original Version, by changing formats or by porting the Font Software to a
    new environment.

    "Author" refers to any designer, engineer, programmer, technical
    writer or other person who contributed to the Font Software.

    PERMISSION & CONDITIONS
    Permission is hereby granted, free of charge, to any person obtaining
    a copy of the Font Software, to use, study, copy, merge, embed, modify,
    redistribute, and sell modified and unmodified copies of the Font
    Software, subject to the following conditions:

    1) Neither the Font Software nor any of its individual components,
    in Original or Modified Versions, may be sold by itself.

    2) Original or Modified Versions of the Font Software may be bundled,
    redistributed and/or sold with any software, provided that each copy
    contains the above copyright notice and this license. These can be
    included either as stand-alone text files, human-readable headers or
    in the appropriate machine-readable metadata fields within text or
    binary files as long as those fields can be easily viewed by the user.

    3) No Modified Version of the Font Software may use the Reserved Font
    Name(s) unless explicit written permission is granted by the corresponding
    Copyright Holder. This restriction only applies to the primary font name as
    presented to the users.

    4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
    Software shall not be used to promote, endorse or advertise any
    Modified Version, except to acknowledge the contribution(s) of the
    Copyright Holder(s) and the Author(s) or with their explicit written
    permission.

    5) The Font Software, modified or unmodified, in part or in whole,
    must be distributed entirely under this license, and must not be
    distributed under any other license. The requirement for fonts to
    remain under this license does not apply to any document created
    using the Font Software.

    TERMINATION
    This license becomes null and void if any of the above conditions are
    not met.

    DISCLAIMER
    THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
    EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
    MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
    OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
    COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
    INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
    DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
    FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
    OTHER DEALINGS IN THE FONT SOFTWARE.
    """
    }
}
