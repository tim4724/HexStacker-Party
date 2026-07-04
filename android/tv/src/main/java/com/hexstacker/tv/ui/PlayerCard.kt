package com.hexstacker.tv.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.hexstacker.tv.R

/**
 * One lobby seat — a filled player card or a dashed empty placeholder
 * (web `.player-card` / `.player-card.empty`, tvOS `buildPlayerCard`). 2:1 aspect,
 * two 50/50 halves (name over LEVEL pill). The caller sizes the card via
 * [modifier] (e.g. `Modifier.width(cardW)`); aspect ratio derives the height.
 *
 * Filled: `--bg-card` bg + 2dp player-colored border, name + "LEVEL <n>".
 * Empty: transparent + 2dp dashed `--text-secondary` border, "P<k>", blank level
 * value, level group at 0.45 opacity.
 */
@Composable
fun PlayerCard(
    player: LobbyPlayer?,
    slotIndex: Int,
    vp: Vp,
    modifier: Modifier = Modifier,
) {
    val shape = RoundedCornerShape(Tokens.radiusMd)
    // Web's .identity-name is clamp(1.5rem,4vmin,1.7rem) — capped at 1.7rem (~27px)
    // on any TV. A capped .sp value renders ~1.5x too large at the gallery's hdpi
    // density, so express it as the equivalent vmin % (density-independent in px).
    val nameSize = vp.vminSp(16f, 2.5f, 24f) // ~27px, matches web .identity-name cap
    val levelSize = vp.vminSp(15.2f, 2f, 19.2f) // .card-level__* clamp(0.95rem,2vmin,1.2rem)
    val padH = vp.vminDp(8f, 1.4f, 14f) // half padding clamp(8px,1.4vmin,14px)
    val levelGap = vp.vminDp(6.4f, 0.7f, 10.4f) // .card-level gap clamp(0.4rem,0.7vmin,0.65rem)

    val filled = player != null
    val nameColor = if (filled) playerColor(player!!.colorIndex) else Tokens.textSecondary
    val dividerColor = if (filled) Tokens.bgGlass else Tokens.textSecondary

    val cardModifier = if (filled) {
        modifier
            .aspectRatio(2f)
            .clip(shape)
            .background(Tokens.bgCard, shape)
            .border(2.dp, playerColor(player!!.colorIndex), shape)
    } else {
        modifier
            .aspectRatio(2f)
            .drawBehind {
                val stroke = 2.dp.toPx()
                val on = size.height * 0.10f // tvOS dash [h*0.10, h*0.07]
                val off = size.height * 0.07f
                drawRoundRect(
                    color = Tokens.textSecondary,
                    topLeft = Offset(stroke / 2f, stroke / 2f),
                    size = Size(size.width - stroke, size.height - stroke),
                    cornerRadius = CornerRadius(Tokens.radiusMd.toPx()),
                    style = Stroke(width = stroke, pathEffect = PathEffect.dashPathEffect(floatArrayOf(on, off))),
                )
            }
    }

    Column(cardModifier) {
        // Top half — name.
        Box(
            Modifier.fillMaxWidth().weight(1f).padding(horizontal = padH),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                // Empty-slot placeholder name: DisplayUI `'P' + (idx+1)`.
                text = if (filled) player!!.name else stringResource(R.string.player_placeholder, slotIndex + 1),
                style = AppType.cardName.copy(fontSize = nameSize, color = nameColor),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                textAlign = TextAlign.Center,
            )
        }
        // Bottom half — LEVEL pill with a 1px inset divider at its top edge.
        Box(
            Modifier.fillMaxWidth().weight(1f)
                .then(if (filled) Modifier else Modifier.alpha(0.45f)), // .empty .card-level opacity 0.45
        ) {
            Box(
                Modifier.align(Alignment.TopCenter).fillMaxWidth().padding(horizontal = padH),
            ) {
                Box(Modifier.fillMaxWidth().height(1.dp).background(dividerColor))
            }
            Row(
                Modifier.fillMaxWidth().padding(horizontal = padH).align(Alignment.Center),
                horizontalArrangement = Arrangement.spacedBy(levelGap, Alignment.CenterHorizontally),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = stringResource(R.string.level_heading).uppercase(), // .card-level__heading text-transform uppercase
                    style = AppType.cardLevelHeading.copy(fontSize = levelSize, color = Tokens.textSecondary),
                )
                if (filled) {
                    Text(
                        text = player!!.level.toString(),
                        style = AppType.cardLevelValue.copy(fontSize = levelSize, color = Tokens.textPrimary),
                    )
                }
                // Empty slot leaves the value blank (reads just "LEVEL").
            }
        }
    }
}
