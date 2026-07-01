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
    // Cross-ref: bgCard/bgCardSoft (and #FFE066 in wordmarkStops below) are also
    // parsed as `Rgb` in render/TvColors.kt. Nothing enforces equality, so keep
    // the two hex sets in sync until a :core Theme token unifies them.
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
    val borderStrong = Color(0x29FFF8EC) // --border-strong rgba(.,.,.,0.16)

    val btnPrimaryText = Color(0xFF1E1A2B) // --btn-primary-text (dark text on tinted CTAs)
    val overlayBg = Color(0xE01E1A2B) // --overlay-bg rgba(bgPrimary,0.88)

    val joinPillBg = Color(0x38000000) // #join-url background rgba(0,0,0,0.22)
    val partySubColor = Color(0xFFFFF3C2) // .gradient-title__sub color #fff3c2
    val white = Color(0xFFFFFFFF)

    // Wordmark gradient stops — PLAYER_COLORS spectrum order (== .gradient-title 135deg).
    val wordmarkStops = listOf(
        Color(0xFFFF6B6B), Color(0xFFFF8C42), Color(0xFFFFE066), Color(0xFF7BED6F),
        Color(0xFF4ECDC4), Color(0xFF5B7FFF), Color(0xFFA78BFA), Color(0xFFF178D8),
    )

    // Radii (theme.css)
    val radiusSm = 6.dp
    val radiusMd = 12.dp
    val radiusLg = 18.dp
    val radiusXl = 22.dp
}

/** Player identity color from the single-source `:core` [Theme] spectrum (slots 0..7). */
fun playerColor(slot: Int): Color = Color(Theme.playerColor(slot).toArgb())

/**
 * Host tint: the host player's identity color, or [Tokens.accentPrimary] when
 * there is no host (mirrors `applyHostTint()` / tvOS `hostColor`).
 */
fun hostTint(hostColorIndex: Int?): Color =
    hostColorIndex?.let { playerColor(it) } ?: Tokens.accentPrimary
