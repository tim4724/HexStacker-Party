import SwiftUI

/// Full-screen Licenses page for the tvOS display, reached from the About page.
/// One focusable row per third-party component the app actually bundles (mirroring
/// the Android LicensesScreen): d-pad Up/Down moves row focus and the focus engine
/// scrolls the list, Select folds the full license text open in place, and Menu
/// steps back (DisplayModel.handleMenu, fed by PressHostController).
///
/// The list is short by design: unlike Android (which bundles the whole AndroidX /
/// Compose Apache stack), the tvOS app runs on Apple system frameworks
/// (JavaScriptCore, SpriteKit, SwiftUI, Foundation) which are Apple-provided and
/// need no attribution. What DOES ship third-party is the WebRTC binary (BSD-3),
/// the Orbitron and Baloo 2 fonts (OFL 1.1), and the lobby music (CC BY 3.0).
///
/// English-only, like the Android screen: this is TV-only chrome the web has no
/// equivalent for, so there is no shared i18n.js string to mirror via `tr()`.
struct LicensesView: View {
    @State private var expanded: Set<Int> = []
    @FocusState private var focusedRow: Int?

    var body: some View {
        GeometryReader { geo in
            let vp = Vp(size: geo.size)
            let W = vp.w, H = vp.h
            let margin = H * 0.05
            // Row proportions are relative to the content width (the list width
            // after the horizontal margin).
            let contentW = W - (W * 0.05) * 2

            VStack(alignment: .leading, spacing: 0) {
                // verbatim: deliberately untranslated TV chrome (Android marks its
                // twins MissingTranslation), kept out of the string catalog.
                Text(verbatim: "Licenses")
                    .styled(font: AppFont.brandExtraBold, size: max(30, min(H * 0.05, 52)),
                            color: UITheme.textPrimary(), tracking: 0.08)
                Text(verbatim: "Press Menu to return")
                    .styled(font: AppFont.brandRegular, size: max(22, min(H * 0.033, 32)),
                            color: UITheme.textFaint, tracking: 0.02)
                    .padding(.top, margin * 0.3)
                    .padding(.bottom, margin * 0.5)

                ScrollView(showsIndicators: false) {
                    LazyVStack(spacing: contentW * 0.016) {
                        ForEach(Array(Self.entries.enumerated()), id: \.offset) { index, entry in
                            LicenseRow(entry: entry, width: contentW,
                                       expanded: expanded.contains(index),
                                       onToggle: { toggle(index) })
                                .focused($focusedRow, equals: index)
                        }
                    }
                    // Room for the 4pt focus ring: the scroll view clips at
                    // its bounds (web #results-list keeps 4px padding for
                    // the same reason).
                    .padding(4)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .padding(.horizontal, W * 0.05)
            .padding(.vertical, H * 0.05)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            // Only the fill bleeds full-screen; the content stays inside the
            // title-safe area (real TVs report overscan insets).
            .background(UITheme.bgPrimary.ignoresSafeArea())
        }
        // Seat focus on the first row so the remote is live on entry (matches the
        // Android screen and the SpriteKit overlay opening focused on row 0).
        .onAppear { focusedRow = 0 }
    }

    private func toggle(_ i: Int) {
        if expanded.contains(i) { expanded.remove(i) } else { expanded.insert(i) }
    }

    // MARK: - Attribution data (English-only license text, embedded verbatim)

    // fileprivate so the sibling LicenseRow in this file can name the type.
    fileprivate struct Entry {
        let name: String
        let author: String
        let license: String
        let body: String
    }

    // Music and fonts lead the list (the app's most audible/visible credits); the
    // WebRTC binary attribution follows (matches the Android assembleLicenseList order).
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

/// A focusable, expand-in-place license row. Focus highlights the header with
/// the game-UI convention shared with ChromeButton / MusicSwitchView (4pt white
/// ring + 6% white wash), minus the scale pop, which reads wrong on a
/// full-width list row; Select toggles the license body, whose paragraphs are
/// their own focus stops.
private struct LicenseRow: View {
    let entry: LicensesView.Entry
    let width: CGFloat
    let expanded: Bool
    let onToggle: () -> Void

    /// The expanded body split at blank lines: each paragraph is a focus stop.
    static func chunks(for entry: LicensesView.Entry) -> [String] {
        entry.body.components(separatedBy: "\n\n").filter { !$0.isEmpty }
    }

    var body: some View {
        let padX = width * 0.022
        let padY = width * 0.016

        // One element in the outer list: tight internal spacing keeps the
        // paragraphs reading as the row's body, not as separate list items.
        VStack(alignment: .leading, spacing: 2) {
            Button(action: onToggle) {
                VStack(alignment: .leading, spacing: padY * 0.4) {
                    HStack(alignment: .top, spacing: 16) {
                        // Name takes the row and truncates (Android weight(1f)); the license
                        // keeps its intrinsic width and stays pinned right.
                        Text(entry.name)
                            .styled(font: AppFont.brandBold, size: max(18, min(width * 0.015, 28)),
                                    color: UITheme.textPrimary(), tracking: 0.02)
                            .lineLimit(1)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Text(entry.license)
                            .styled(font: AppFont.brandRegular, size: max(13, min(width * 0.011, 20)),
                                    color: UITheme.textSecondary, tracking: 0.02)
                            .lineLimit(1)
                            .layoutPriority(1)
                    }
                    Text(entry.author)
                        .styled(font: AppFont.brandRegular, size: max(12, min(width * 0.0095, 18)),
                                color: UITheme.textFaint, tracking: 0.02)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, padX)
                .padding(.vertical, padY)
            }
            .buttonStyle(LicenseRowStyle())

            if expanded {
                // Monospace: display faces are unreadable at license-text length.
                // Fixed 20pt, matching the SpriteKit Menlo body. One FOCUSABLE
                // paragraph per chunk: the Siri Remote moves focus by touch
                // swipes (which bypass onMoveCommand entirely), so paragraph
                // focus stops are what lets the engine scroll a body taller
                // than the screen. Select on a paragraph folds the body shut.
                ForEach(Array(Self.chunks(for: entry).enumerated()), id: \.offset) { _, para in
                    Button(action: onToggle) {
                        Text(para)
                            .font(.custom("Menlo", size: 20))
                            .foregroundColor(UITheme.textSecondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, padX)
                            .padding(.vertical, padY * 0.4)
                    }
                    .buttonStyle(LicenseChunkStyle())
                }
            }
        }
    }
}

/// Reading-position highlight for a focused license paragraph: the row-card
/// fill for continuity with the header, plus a quiet wash when focused (a
/// ring per paragraph would read as noise at license-text length).
private struct LicenseChunkStyle: ButtonStyle {
    @Environment(\.isFocused) private var focused

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(
                ZStack {
                    UITheme.bgSecondary
                    if focused { Color.white.opacity(0.05) }
                }
            )
            .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

private struct LicenseRowStyle: ButtonStyle {
    @Environment(\.isFocused) private var focused

    func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: 12)   // var(--radius-md)
        return configuration.label
            .background(
                ZStack {
                    UITheme.bgSecondary
                    if focused { Color.white.opacity(0.06) }   // 6% focus wash over the fill
                }
            )
            .clipShape(shape)
            .overlay(shape.stroke(focused ? Color.white : UITheme.border,
                                  lineWidth: focused ? 4 : 1))
    }
}
