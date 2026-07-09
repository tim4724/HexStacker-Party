package com.hexstacker.tv.ui

import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.em
import com.hexstacker.tv.R

/**
 * Font families + named text styles, mirroring the web's two type roles
 * (theme.css `--font-brand` / `--font-hud`) and the tvOS `AppFont` mapping:
 *
 *  - Baloo 2 (`--font-brand`, weights 400–800) — identity voice: wordmark,
 *    buttons, lobby cards, overlay headings, menu/settings text.
 *  - Orbitron (`--font-hud`, weights 500–900) — scoreboard voice: countdown,
 *    join-url host/code (unambiguous 0/O), result rank/stats. The Canvas
 *    board renderer (render/Fonts.kt) draws HUD labels in Orbitron too.
 *
 * CSS `letter-spacing` is em; Compose `TextStyle.letterSpacing` accepts `.em`,
 * so tracking maps 1:1. Baloo 2 tops out at weight 800, so web 900s map to 800.
 *
 * NOTE: `res/font/orbitron.ttf` / `res/font/baloo2.ttf` must be true variable
 * fonts with a `wght` axis (the bundled ones are). If an emulator's renderer
 * ignores `FontVariation`, swap in static per-weight instances.
 */
object AppType {

    @OptIn(androidx.compose.ui.text.ExperimentalTextApi::class)
    private fun orbitron(weight: Int): Font = Font(
        R.font.orbitron,
        weight = FontWeight(weight),
        variationSettings = FontVariation.Settings(FontVariation.weight(weight)),
    )

    @OptIn(androidx.compose.ui.text.ExperimentalTextApi::class)
    private fun baloo(weight: Int): Font = Font(
        R.font.baloo2,
        weight = FontWeight(weight),
        variationSettings = FontVariation.Settings(FontVariation.weight(weight)),
    )

    val Orbitron: FontFamily = FontFamily(
        orbitron(500), orbitron(600), orbitron(700), orbitron(800), orbitron(900),
    )

    val Baloo2: FontFamily = FontFamily(
        baloo(400), baloo(600), baloo(700), baloo(800),
    )

    private fun hud(weight: Int, tracking: Float): TextStyle = TextStyle(
        fontFamily = Orbitron,
        fontWeight = FontWeight(weight),
        letterSpacing = tracking.em,
    )

    private fun brand(weight: Int, tracking: Float): TextStyle = TextStyle(
        fontFamily = Baloo2,
        fontWeight = FontWeight(weight),
        letterSpacing = tracking.em,
    )

    // weight, em-tracking — from theme.css / display.css / tvOS setStyledText.
    val buttonLabel = brand(700, 0.08f) // ChromeButton, Start
    val qrScanLabel = brand(700, 0.16f) // "SCAN TO JOIN" (#qr-label)
    val joinHost = hud(600, 0.04f) // join-url host (lowercase)
    val joinCode = hud(900, 0.18f) // join-url code (.join-url__code 0.18em)
    val cardName = brand(800, 0.04f) // player name (.identity-name)
    val cardLevelHeading = brand(700, 0.10f) // "LEVEL" (.card-level__heading)
    val cardLevelValue = brand(800, 0.0f) // level value (.card-level__value)
    val countdownNumber = hud(900, 0.05f) // "3/2/1/GO" (#countdown-overlay)
    val pauseTitle = brand(800, 0.15f) // "PAUSED"
    val musicLabel = brand(600, 0.05f) // "Game Music"
    val musicCredit = brand(400, 0.02f) // "Music by …" footer
    val versionTag = hud(600, 0.02f) // About version marker (tvOS AppFont.semibold)
    val connHeading = brand(800, 0.12f) // "RECONNECTING" / "DISCONNECTED"
    val connStatus = brand(700, 0.08f) // "Connection lost..."
    val wordmarkMain = brand(800, 0.06f) // "HEX STACKER" (.brand-lockup)
    val wordmarkSub = brand(600, 0.35f) // "PARTY"
    val resultName = brand(700, 0.0f) // result row name
    val resultRank = hud(900, -0.02f) // result rank ordinal (results.css -0.02em)
    val resultStats = hud(700, 0.0f) // result stats
}
