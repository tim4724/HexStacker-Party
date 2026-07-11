package com.hexstacker.tv.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.hexstacker.core.render.Theme

/**
 * Compose color/dp design tokens, mirroring `public/shared/theme.css` `:root`
 * and `public/shared/theme.js` THEME exactly. Player/piece colors are NOT
 * duplicated here — derive them from the single-source `:core` [Theme]
 * (see [playerColor]).
 */
object Tokens {
    // Backgrounds (theme.css)
    val bgPrimary = Color(0xFF1E1A2B) // --bg-primary  rgb(30,26,43)
    val bgBoard = Color(0xFF15121F) // --bg-board
    val bgSecondary = Color(0xFF181421) // --bg-secondary
    // Cross-ref: bgCard/bgCardSoft are also parsed as `Rgb` in render/TvColors.kt.
    // Nothing enforces equality, so keep the two hex sets in sync until a :core
    // Theme token unifies them.
    val bgCard = Color(0xFF2A2540) // --bg-card     rgb(42,37,64)
    val bgCardSoft = Color(0xFF342E4D) // --bg-card-soft
    val bgGlass = Color(0x0FFFF8EC) // --bg-glass  rgba(255,248,236,0.06)

    // Accents (party palette slot 1 / slot 8)
    val accentPrimary = Color(0xFFFF6B6B) // --accent-primary
    val accentPrimaryDark = Color(0xFFE55A5A) // --accent-primary-dark
    val accentSecondary = Color(0xFFFF8C42) // --accent-secondary
    val accentSecondaryDark = Color(0xFFE67A33) // --accent-secondary-dark

    // Cream text ramp (#F7F1E8 = 247,241,232)
    val textPrimary = Color(0xFFF7F1E8) // --text-primary
    val textSecondary = Color(0xA6F7F1E8) // --text-secondary rgba(.,.,.,0.65)
    val textFaint = Color(0x66F7F1E8) // --text-faint     rgba(.,.,.,0.40)

    // Off-white border ramp (#FFF8EC = 255,248,236)
    val border = Color(0x14FFF8EC) // --border        rgba(.,.,.,0.08)

    val btnPrimaryText = Color(0xFF1E1A2B) // --btn-primary-text (dark text on tinted CTAs)
    val overlayBg = Color(0xE01E1A2B) // --overlay-bg rgba(bgPrimary,0.88)

    val partySubColor = Color(0xFFFFF3C2) // .brand-lockup__sub color #fff3c2
    val white = Color(0xFFFFFFFF)

    // A2 socket family — bgBoard (rgb 21,18,31) at alpha: the shared recessed
    // fill for empty player slots, level pills, and round utility buttons.
    val socketEmpty = Color(0x8C15121F) // .player-card.empty bg rgba(21,18,31,0.55)
    val socketPill = Color(0x5915121F) // .card-level__pill bg rgba(21,18,31,0.35)
    val socketBtn = Color(0x6615121F) // .icon-btn bg rgba(21,18,31,0.4)

    // Warm-paper hairline family (#FFF8EC) beyond the border ramp above.
    val hairlineRing = Color(0x1FFFF8EC) // .icon-btn ring rgba(255,248,236,0.12)
    val hairlineFaint = Color(0x0DFFF8EC) // .player-card.empty ring rgba(255,248,236,0.05)

    // Tonal card surface — srgb approximation of the A2 recipe
    // color-mix(in oklab, <color> 20%, var(--bg-card)).
    fun tonalCard(color: Color, mix: Float = 0.2f): Color = Color(
        red = color.red * mix + bgCard.red * (1f - mix),
        green = color.green * mix + bgCard.green * (1f - mix),
        blue = color.blue * mix + bgCard.blue * (1f - mix),
    )

    // Radii (theme.css)
    val radiusSm = 6.dp
    val radiusMd = 12.dp
    val radiusBtn = 16.dp
    val radiusLg = 18.dp
    val radiusXl = 22.dp
    // .player-card / .result-row 20px. Web-px/1.5 (like the sp rule): a 20dp
    // radius renders 30px at the TV density and reads visibly rounder than web.
    val radiusCard = 13.3.dp
}

/** Player identity color from the single-source `:core` [Theme] spectrum (slots 0..7). */
fun playerColor(slot: Int): Color = Color(Theme.playerColor(slot).toArgb())

/**
 * Host tint: the host player's identity color, or [Tokens.accentPrimary] when
 * there is no host (mirrors `applyHostTint()` / tvOS `hostColor`).
 */
fun hostTint(hostColorIndex: Int?): Color =
    hostColorIndex?.let { playerColor(it) } ?: Tokens.accentPrimary
