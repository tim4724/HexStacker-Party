package com.hexstacker.tv.render

import com.hexstacker.core.render.Rgb

/**
 * :tv-local color tokens that are NOT (yet) carried by `:core` `Theme`.
 *
 * `Theme` exposes `bgPrimary/bgSecondary/bgBoard/nearClear` + the piece/player
 * palettes, but the panel-card surfaces and the KO accents live only in
 * `public/shared/theme.js` today. They're parsed here from the exact web hex
 * strings so the renderer stays byte-faithful. If a `:core` sibling later adds
 * `Theme.bgCard / bgCardSoft / ko*`, swap these for the canonical tokens.
 *
 * Cross-ref: `bgCard`/`triple` (#FFE066) are duplicated as Compose `Color` in
 * `ui/Tokens.kt` (a different package/type system). Nothing enforces equality,
 * so keep the two hex sets in sync until a `:core` Theme token unifies them.
 */
internal object TvColors {
    /** THEME.color.bg.card — the tonal-panel mix base (A2). */
    val bgCard: Rgb = Rgb.fromHex("#2A2540")!!

    /** THEME.color.ko.text / danger — KO label + KO-event flash/sparkle color. */
    val koText: Rgb = Rgb.fromHex("#ff4444")!!

    /** THEME.color.triple — honey, the triple-clear popup color (== pieceColors[3]). */
    val triple: Rgb = Rgb.fromHex("#FFE066")!!

    val white: Rgb = Rgb(255, 255, 255)
    val black: Rgb = Rgb(0, 0, 0)
}
