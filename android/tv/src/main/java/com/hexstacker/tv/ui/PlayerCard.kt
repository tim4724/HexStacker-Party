package com.hexstacker.tv.ui

import androidx.compose.animation.core.LinearOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asComposePath
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.hexstacker.tv.R
import com.hexstacker.tv.render.addRoundedHex

/**
 * One lobby seat — a tonal filled player card or a recessed empty socket
 * (web `.player-card` / `.player-card.empty` A2, tvOS `buildPlayerCard`).
 * 2:1 aspect; the caller sizes the card via [modifier] (e.g.
 * `Modifier.width(cardW)`); aspect ratio derives the height.
 *
 * Filled: borderless 20dp card, the player color mixed into the surface
 * (color-mix 20% into `--bg-card`) and carried by the name; a quiet recessed
 * "LEVEL n" pill under the name.
 * Empty: recessed socket — flat dark inset (`rgba(21,18,31,0.55)`) with a
 * hairline ring and a faint hex opening, breathing slowly. No text.
 */
@Composable
fun PlayerCard(
    player: LobbyPlayer?,
    vp: Vp,
    modifier: Modifier = Modifier,
) {
    val shape = RoundedCornerShape(Tokens.radiusCard)
    // Web display override: .player-card .identity-name clamp(1.5rem,4.5vmin,2.4rem)
    // (display.css 10-foot sizes; the theme.css clamp is the phone's). Bounds are
    // web-px / 1.5 because a capped .sp renders 1.5x larger at the gallery's hdpi
    // density; the vmin % carries through unchanged (720dp * 1.5 = 1080px).
    val nameSize = vp.vminSp(16f, 4.5f, 25.6f) // caps at 38.4px (2.4rem) on a 1080p TV
    val levelSize = vp.vminSp(6.9f, 1.6f, 10.1f) // .card-level__* clamp(0.65rem,1.6vmin,0.95rem)
    val padH = vp.vminDp(8f, 1.4f, 14f) // half padding clamp(8px,1.4vmin,14px)
    val contentGap = vp.vminDp(3f, 0.9f, 9f) // display card name↔pill gap clamp(3px,0.9vmin,9px)

    if (player == null) {
        // Empty slot — recessed socket, breathing slowly (@keyframes breathe:
        // opacity 1 → 0.55 → 1 over 3.2s ease-in-out).
        val breathe = rememberInfiniteTransition(label = "socketBreathe")
        val socketAlpha by breathe.animateFloat(
            initialValue = 1f,
            targetValue = 0.55f,
            animationSpec = infiniteRepeatable(
                animation = tween(1600, easing = LinearOutSlowInEasing),
                repeatMode = RepeatMode.Reverse,
            ),
            label = "socketBreatheAlpha",
        )
        Box(
            modifier
                .aspectRatio(2f)
                .alpha(socketAlpha)
                .clip(shape)
                .background(Tokens.socketEmpty, shape)
                .border(1.dp, Tokens.hairlineFaint, shape),
            contentAlignment = Alignment.Center,
        ) {
            // Faint rounded-hex opening (web .player-card__opening, sized
            // clamp(28px,5.5vmin,56px) wide for 10-foot viewing, at 0.5 alpha).
            SocketOpening(Modifier.size(vp.vminDp(28f, 5.5f, 56f)).alpha(0.5f))
        }
        return
    }

    val color = playerColor(player.colorIndex)
    Column(
        modifier
            .aspectRatio(2f)
            .clip(shape)
            .background(Tokens.tonalCard(color), shape),
        verticalArrangement = Arrangement.spacedBy(contentGap, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = player.name,
            style = AppType.cardName.copy(fontSize = nameSize, color = color),
            modifier = Modifier.fillMaxWidth().padding(horizontal = padH),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            textAlign = TextAlign.Center,
        )
        // Quiet "LEVEL n" pill — recessed dark chip so the level reads as
        // metadata under the colored name (web .card-level__pill).
        Row(
            Modifier
                .clip(CircleShape)
                .background(Tokens.socketPill, CircleShape)
                .padding(horizontal = vp.vminDp(6.9f, 1.6f, 10.1f), vertical = vp.vminDp(2f, 0.45f, 3f)),
            horizontalArrangement = Arrangement.spacedBy(vp.vminDp(3.5f, 0.8f, 5f)),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = stringResource(R.string.level_heading).uppercase(), // .card-level__heading text-transform uppercase
                style = AppType.cardLevelHeading.copy(fontSize = levelSize, color = Tokens.textSecondary),
            )
            Text(
                text = player.level.toString(),
                style = AppType.cardLevelValue.copy(fontSize = levelSize, color = Tokens.textPrimary),
            )
        }
    }
}

/**
 * The faint hex opening inside an empty socket (web `buildSocketOpening`'s SVG:
 * a rounded flat-top hex, cream stroke at 0.45 over a whisper fill).
 */
@Composable
private fun SocketOpening(modifier: Modifier = Modifier) {
    Canvas(modifier.aspectRatio(2f / 1.732f)) {
        val r = size.width / 2f
        val path = android.graphics.Path().apply {
            addRoundedHex(size.width / 2f, size.height / 2f, r * 0.9f, r * 0.12f)
        }.asComposePath()
        drawPath(path, androidx.compose.ui.graphics.Color(0x08FFF8EC)) // fill rgba(255,248,236,0.03)
        drawPath(path, Tokens.textPrimary.copy(alpha = 0.45f), style = Stroke(width = 2.dp.toPx()))
    }
}
