import SwiftUI
import UIKit

/// Full-screen Licenses list for the tvOS display, pushed from the About page.
/// One focusable row per third-party component the app actually bundles: d-pad
/// Up/Down moves row focus and the focus engine scrolls the list, Select pushes
/// that license's text as its own page (LicenseTextView), and Menu pops back
/// (the NavigationStack's own handling).
///
/// A page rather than the old fold-open-in-place: folding a body open grew the
/// list by thousands of points and stepped focus through every paragraph, which
/// read poorly on the remote. A pushed page is the platform's own idiom, the
/// list never resizes, and the text scrolls itself.
///
/// The list is short by design: unlike Android (which bundles the whole AndroidX /
/// Compose Apache stack), the tvOS app runs on Apple system frameworks
/// (JavaScriptCore, SpriteKit, SwiftUI, Foundation) which are Apple-provided and
/// need no attribution. What DOES ship third-party is the WebRTC binary (BSD-3),
/// the Orbitron and Baloo 2 fonts (OFL 1.1), and the lobby music (CC BY 3.0).
///
/// The title localizes via `licenses_title`; the per-component license bodies and
/// names (BSD-3, OFL, the font/library names) stay English, as canonical license
/// texts are. No on-screen back hint (tvOS HIG: the remote navigates back).
struct LicensesListView: View {
    @FocusState private var focusedRow: Int?

    var body: some View {
        LicensePageScaffold(title: tr("licenses_title")) { contentW, _ in
            ScrollView(showsIndicators: false) {
                LazyVStack(spacing: contentW * 0.016) {
                    ForEach(Array(Self.entries.enumerated()), id: \.offset) { index, entry in
                        NavigationLink(value: AboutRoute.license(index)) {
                            LicenseRowLabel(entry: entry, width: contentW)
                        }
                        .buttonStyle(LicenseRowStyle())
                        .focused($focusedRow, equals: index)
                    }
                }
                // Room for the 4pt focus ring: the scroll view clips at
                // its bounds (web #results-list keeps 4px padding for
                // the same reason).
                .padding(4)
            }
        }
        // Seat focus on the first row so the remote is live on entry (matches the
        // Android screen; the stack restores it here after a text-page pop).
        .onAppear { focusedRow = 0 }
    }

    // MARK: - Attribution data (English-only license text, embedded verbatim)

    // fileprivate so the sibling LicenseTextView / LicenseRowLabel can name the type.
    fileprivate struct Entry {
        let name: String
        let author: String
        let license: String
        let body: String
    }

    // Music and fonts lead the list (the app's most audible/visible credits); the
    // WebRTC binary attribution follows (matches the Android assembleLicenseList order).
    fileprivate static let entries: [Entry] = [
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

/// One license's text, full-screen and scrolling on its own (pushed by a list
/// row; the page title is the component name, existing data, no new copy).
struct LicenseTextView: View {
    let index: Int

    var body: some View {
        let entry = LicensesListView.entries[min(max(index, 0), LicensesListView.entries.count - 1)]
        LicensePageScaffold(title: entry.name) { _, viewportH in
            LicenseTextBody(text: entry.body, viewportH: viewportH)
        }
    }
}

/// The text sliced into blocks of HALF THE VIEWPORT, each an invisible focus
/// stop, and the FOCUS ENGINE does the scrolling: Down moves to the next
/// block, the engine scrolls it into view, and the text advances half a
/// screen. Focusable content is not a workaround here, it IS how tvOS
/// scrolls: a ScrollView moves to reveal the focused view, and there is no
/// other lever. SwiftUI has no first-class long-text view, and the UIKit one
/// does not survive the trip (a UITextView rendered but never took focus with
/// isSelectable set, canBecomeFocused overridden, and a controller vending
/// preferredFocusEnvironments); a plain `ScrollView { Text }.focusable()`
/// does not scroll either. Blocks and not paragraphs: paragraphs are uneven,
/// so the text lurched a line at a time through short ones. This mechanism
/// (and those measurements) come from the about-licenses-rjwyn spike.
private struct LicenseTextBody: View {
    let text: String
    let viewportH: CGFloat

    /// Monospace: display faces are unreadable at license-text length, and the
    /// canonical texts are hard-wrapped for a fixed pitch. 26pt for the
    /// 10-foot read; the ~72-column hard wrap still fits the full-width page
    /// (72 chars x ~0.6em advance = ~1120pt inside the ~1730pt content width).
    private static let size: CGFloat = 26
    private static let lineH = UIFont(name: "Menlo", size: size)?.lineHeight ?? size * 1.21

    /// Sliced into half-viewport blocks, measured in LINES: the text is
    /// hard-wrapped well inside the full-width page, so no line soft-wraps and
    /// a block's height is exactly its line count times the line height.
    private var blocks: [String] {
        let lines = text.components(separatedBy: "\n")
        let per = max(4, Int((viewportH * 0.5) / Self.lineH))
        return stride(from: 0, to: lines.count, by: per).map {
            lines[$0..<min($0 + per, lines.count)].joined(separator: "\n")
        }
    }

    var body: some View {
        ScrollView(showsIndicators: false) {
            // No spacing and no decoration: the blocks are slices of ONE text,
            // so any gap or highlight would show up as a seam mid-paragraph.
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(blocks.enumerated()), id: \.offset) { _, chunk in
                    Text(chunk)
                        .font(.custom("Menlo", size: Self.size))
                        .foregroundColor(UITheme.textSecondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .focusable()
                }
            }
        }
    }
}

/// The shared Licenses page chrome: transparent over the BoardScene's ambient
/// falling pieces (these pages live under `case .lobby`; the accent vignette
/// mirrors LobbyView for backdrop continuity), leading title inside the
/// title-safe area, and the content sized by a GeometryReader so the text
/// page can slice against the real body height.
private struct LicensePageScaffold<Content: View>: View {
    let title: String
    @ViewBuilder let content: (CGFloat, CGFloat) -> Content   // (contentW, bodyH)

    var body: some View {
        GeometryReader { geo in
            let vp = Vp(fullScreenOf: geo)
            let W = vp.w, H = vp.h
            let margin = H * 0.05
            let contentW = W - (W * 0.05) * 2

            VStack(alignment: .leading, spacing: 0) {
                // No on-screen back hint (tvOS HIG): the remote's Back/Menu button
                // navigates back implicitly. The title carries the gap the hint used
                // to hold before the list.
                Text(title)
                    .styled(font: AppFont.brandExtraBold, size: max(30, min(H * 0.05, 52)),
                            color: UITheme.textPrimary(), tracking: 0.08)
                    .lineLimit(1)
                    .padding(.bottom, margin * 0.5)

                GeometryReader { body in
                    content(contentW, body.size.height)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .padding(.horizontal, W * 0.05)
            .padding(.vertical, H * 0.05)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            // Only the vignette bleeds full-screen; the content stays inside
            // the title-safe area (real TVs report overscan insets).
            .background(
                RadialGradient(colors: [UITheme.accentPrimary.opacity(0.06), .clear],
                               center: UnitPoint(x: 0.5, y: 0.3),
                               startRadius: 0,
                               endRadius: max(W, H) * 0.575)
                    .ignoresSafeArea()
            )
        }
    }
}

/// A license list row face in the app's card language: name over author on
/// the left, the license tag in a recessed capsule chip on the right (the
/// lobby card's LEVEL pill treatment).
private struct LicenseRowLabel: View {
    let entry: LicensesListView.Entry
    let width: CGFloat

    var body: some View {
        let padX = width * 0.022
        let padY = width * 0.016
        // 10-foot scale in line with the result rows (~3vh names): the first
        // cut used web-ish point sizes and read too small from the couch.
        let nameSize = max(24, min(width * 0.019, 36))
        let subSize = max(18, min(width * 0.014, 26))
        let chipSize = max(16, min(width * 0.011, 22))

        HStack(spacing: 16) {
            VStack(alignment: .leading, spacing: padY * 0.35) {
                Text(entry.name)
                    .styled(font: AppFont.brandBold, size: nameSize,
                            color: UITheme.textPrimary(), tracking: 0.02)
                    .lineLimit(1)
                Text(entry.author)
                    .styled(font: AppFont.brandRegular, size: subSize,
                            color: UITheme.textSecondary, tracking: 0.02)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            // Quiet chip like the lobby's LEVEL pill: recessed dark capsule,
            // HUD face, keeps its intrinsic width pinned right.
            Text(entry.license)
                .styled(font: AppFont.name, size: chipSize,
                        color: UITheme.textSecondary, tracking: 0.06)
                .lineLimit(1)
                .padding(.horizontal, chipSize)
                .frame(height: chipSize * 2.3)
                .background(Capsule().fill(UITheme.socket(0.35)))
                .layoutPriority(1)
        }
        .padding(.horizontal, padX)
        .padding(.vertical, padY)
    }
}

/// Borderless raised card (web .result-row: 20px radius, bg-card, --shadow-sm),
/// the same surface as the lobby player cards and result rows; focus adds the
/// white ring + 6% wash, minus the scale pop, which reads wrong on a
/// full-width row. Press sinks the row flat instead: wash and shadow drop
/// together (web .btn:active's box-shadow: none).
private struct LicenseRowStyle: ButtonStyle {
    @Environment(\.isFocused) private var focused

    func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: 20)
        let pressed = configuration.isPressed
        return configuration.label
            .background(
                shape.fill(UITheme.bgCard)
                    .shadow(color: .black.opacity(pressed ? 0 : 0.32), radius: 4, x: 0, y: 2)
            )
            .overlay(shape.fill(Color.white.opacity(focused && !pressed ? 0.06 : 0)))
            .overlay(shape.stroke(focused ? Color.white : .clear, lineWidth: 4))
            .animation(PressFeel.press, value: pressed)
    }
}
