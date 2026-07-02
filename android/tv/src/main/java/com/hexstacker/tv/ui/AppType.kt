package com.hexstacker.tv.ui

import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.em
import com.hexstacker.tv.R

/**
 * Orbitron variable-font family + named text styles, mirroring the web
 * (`Orbitron`, weights 100–900) and the tvOS `AppFont`/`setStyledText` mapping.
 *
 * Weight ↔ web:
 *  - 700 Bold      — default HUD/labels/buttons
 *  - 800 ExtraBold — player names, level value
 *  - 900 Black     — wordmark, countdown, PAUSED, results rank
 *  - 600 SemiBold  — wordmark subtitle, join-url host, "Game Music"
 *
 * CSS `letter-spacing` is em; Compose `TextStyle.letterSpacing` accepts `.em`,
 * so tracking maps 1:1.
 *
 * NOTE: `res/font/orbitron.ttf` must be a true variable font with a `wght` axis
 * (the bundled `Orbitron[wght].ttf` is). If an emulator's renderer ignores
 * `FontVariation`, swap in static per-weight instances.
 */
object AppType {

    @OptIn(androidx.compose.ui.text.ExperimentalTextApi::class)
    private fun orbitron(weight: Int): Font = Font(
        R.font.orbitron,
        weight = FontWeight(weight),
        variationSettings = FontVariation.Settings(FontVariation.weight(weight)),
    )

    val Orbitron: FontFamily = FontFamily(
        orbitron(500), orbitron(600), orbitron(700), orbitron(800), orbitron(900),
    )

    private fun style(weight: Int, tracking: Float): TextStyle = TextStyle(
        fontFamily = Orbitron,
        fontWeight = FontWeight(weight),
        letterSpacing = tracking.em,
    )

    // weight, em-tracking — from theme.css / display.css / tvOS setStyledText.
    val buttonLabel = style(700, 0.08f) // ChromeButton, Start
    val qrScanLabel = style(700, 0.16f) // "SCAN TO JOIN" (#qr-label)
    val joinHost = style(600, 0.04f) // join-url host (lowercase)
    val joinCode = style(900, 0.18f) // join-url code (.join-url__code 0.18em)
    val cardName = style(800, 0.04f) // player name (.identity-name)
    val cardLevelHeading = style(700, 0.10f) // "LEVEL" (.card-level__heading)
    val cardLevelValue = style(800, 0.0f) // level value (.card-level__value)
    val countdownNumber = style(900, 0.05f) // "3/2/1/GO" (#countdown-overlay)
    val pauseTitle = style(900, 0.15f) // "PAUSED"
    val musicLabel = style(600, 0.05f) // "Game Music"
    val connHeading = style(900, 0.12f) // "RECONNECTING" / "DISCONNECTED"
    val connStatus = style(700, 0.08f) // "Connection lost..."
    val wordmarkMain = style(900, 0.08f) // "HEX STACKER"
    val wordmarkSub = style(600, 0.35f) // "PARTY"
    val resultName = style(700, 0.0f) // result row name
    val resultRank = style(900, -0.02f) // result rank ordinal (results.css -0.02em)
    val resultStats = style(700, 0.0f) // result stats
}
