package com.hexstacker.tv.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.hexstacker.tv.R
import kotlinx.coroutines.delay
import kotlin.math.hypot
import kotlin.math.max

/**
 * Results overlay (web `renderResults` / `#results-screen`, tvOS `buildResults`).
 * Ranked rows over the frozen board: winner radial glow, player-colored rank +
 * name, lines/level stats, recessed-socket late-joiner rows. NO title/heading (web
 * `#results-screen` is just the list + buttons, no logo). The PLAY AGAIN primary
 * CTA is host-tinted (web `applyHostTint`). No anti-misclick gate on the TV (a
 * couch remote, not a phone): buttons are live and focusable immediately.
 *
 * Stateless: [results] from the coordinator's `showResults`, [hostColorIndex] the
 * current host's color slot; [onPlayAgain] = `remoteStartMatch()`, [onNewGame] =
 * `remoteReturnToLobby()`.
 */
@Composable
fun ResultsScreen(
    results: List<ResultCard>,
    hostColorIndex: Int?,
    onPlayAgain: () -> Unit,
    onNewGame: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val sorted = remember(results) { results.sortedBy { it.rank ?: 999 } }
    val solo = sorted.size == 1
    val winnerGlow = sorted.firstOrNull()?.colorIndex
        ?.let { playerColor(it).copy(alpha = 0.08f) }
        ?: Color(0xFFFFD700).copy(alpha = 0.06f) // default gold #ffd700 @ 0.06

    val playAgainFocus = remember { FocusRequester() }
    // Buttons are live immediately — no anti-misclick gate on the TV. Grab D-pad
    // focus for the primary CTA on entry.
    LaunchedEffect(Unit) { runCatching { playAgainFocus.requestFocus() } }

    BoxWithConstraints(
        modifier
            .fillMaxSize()
            .drawBehind {
                drawRect(Tokens.overlayBg)
                val cx = size.width * 0.5f
                val cy = size.height * 0.3f
                drawRect(
                    Brush.radialGradient(
                        colors = listOf(winnerGlow, Color.Transparent),
                        center = Offset(cx, cy),
                        // web: 60% of the farthest-corner distance from the glow center
                        radius = 0.6f * hypot(max(cx, size.width - cx), max(cy, size.height - cy)),
                    ),
                )
            },
    ) {
        val vp = Vp(maxWidth.value, maxHeight.value)
        Column(
            Modifier
                .fillMaxSize()
                .padding(horizontal = (vp.wDp * 0.05f).dp, vertical = (vp.hDp * 0.05f).dp),
            // No wordmark on results (matches web #results-screen); center the list +
            // buttons as a group with a gap between them.
            verticalArrangement = Arrangement.spacedBy(vp.vhDp(19.2f, 3f, 48f), Alignment.CenterVertically),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Column(
                // Web #results-list is width:90% capped at 860px (~45% of a 1080p
                // TV). An absolute dp cap renders ~1.5x wider at the gallery's hdpi
                // density, so cap at a viewport fraction like the rest of the lobby.
                Modifier.widthIn(max = vp.vwDp(420f, 45f, 640f)).fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(vp.vhDp(8f, 1f, 16f)),
            ) {
                sorted.forEachIndexed { i, res ->
                    // Keyed like LobbyScreen's PlayerGrid: late joiners append to `sorted` at
                    // runtime, and the key keeps each row's entrance Animatable with its player.
                    key(res.playerId) {
                        ResultRow(res = res, index = i, solo = solo, vp = vp)
                    }
                }
            }

            Row(
                horizontalArrangement = Arrangement.spacedBy(vp.vwDp(16f, 2f, 32f)),
            ) {
                ChromeButton(
                    text = stringResource(R.string.play_again),
                    primary = true,
                    tint = hostTint(hostColorIndex), // web tints the primary CTA with the host color (applyHostTint)
                    focusRequester = playAgainFocus,
                    fontSize = vp.vhSp(17.6f, 2.4f, 27.2f),
                    contentPadding = PaddingValues(
                        horizontal = vp.vwDp(24f, 3f, 48f),
                        vertical = vp.vhDp(14.4f, 2f, 27.2f),
                    ),
                    minWidth = vp.vhDp(220f, 26f, 340f),
                    onClick = onPlayAgain,
                )
                ChromeButton(
                    text = stringResource(R.string.new_game),
                    primary = false,
                    tint = Tokens.accentPrimary,
                    fontSize = vp.vhSp(17.6f, 2.4f, 27.2f),
                    contentPadding = PaddingValues(
                        horizontal = vp.vwDp(24f, 3f, 48f),
                        vertical = vp.vhDp(14.4f, 2f, 27.2f),
                    ),
                    minWidth = vp.vhDp(220f, 26f, 340f),
                    onClick = onNewGame,
                )
            }
        }
    }
}

@Composable
private fun ResultRow(res: ResultCard, index: Int, solo: Boolean, vp: Vp) {
    val shape = RoundedCornerShape(Tokens.radiusCard) // .result-row 20px (A2)
    // Hoisted so they can be used inside non-composable lambdas / branches below.
    val lateJoinerRank = stringResource(R.string.late_joiner_rank) // DisplayUI '–' rank
    val playerFallback = stringResource(R.string.player)
    val playerCol = res.colorIndex?.let { playerColor(it) }
    // Web is 3vh / 2.6vh (uncapped on a TV). Lo/hi caps are px, which render ~1.5x
    // large as .sp at the gallery density, so scale the caps to let the vh % govern.
    val rankSize = vp.vhSp(16f, 3f, 30f) // web result name/rank ~3vh (32px @1080)
    val statsSize = vp.vhSp(13f, 2.6f, 24f) // web result stats ~2.6vh (28px @1080)
    // Web's .result-stats has no font-family override — it inherits the plain
    // system font (Roboto), unlike the Baloo name / Orbitron rank. Match that.
    val statsStyle = AppType.resultStats.copy(fontFamily = FontFamily.Default, fontWeight = FontWeight.Medium)
    val gap = 13.3.dp // .result-row gap 1.25rem = 20px (web-px/1.5)

    // Stagger entrance: fade + slide up, delay 0.2 + i*0.08 s.
    val enter = remember(index) { Animatable(0f) }
    LaunchedEffect(index) {
        delay((200L + index * 80L))
        enter.animateTo(1f, tween(400))
    }

    // Borderless card matching the lobby's tonal cards (web .result-row A2:
    // bg-card + --shadow-sm); late joiners get the recessed socket treatment
    // (.result-row--joining: no shadow) instead of a dashed rim.
    val base = Modifier
        .fillMaxWidth()
        .graphicsLayer {
            alpha = enter.value * if (res.newPlayer) 0.75f else 1f
            translationY = (1f - enter.value) * 10.dp.toPx()
        }

    val bordered = if (res.newPlayer) {
        base
            .clip(shape)
            .background(Tokens.socketEmpty, shape)
            .border(1.dp, Tokens.hairlineFaint, shape)
    } else {
        base
            .shadowSm(Tokens.radiusCard)
            .clip(shape)
            .background(Tokens.bgCard, shape)
    }

    Row(
        // Web paddings (all bounds web-px/1.5 in dp — the right cap and the
        // vertical floor are active at 1080p): left clamp(0.7rem,1.3vw,1.3rem),
        // right clamp(1.2rem,2.4vw,2.4rem), vertical clamp(0.8rem,1.6vh,1.5rem).
        bordered.padding(
            PaddingValues(
                start = vp.vwDp(7.5f, 1.3f, 13.9f),
                end = vp.vwDp(12.8f, 2.4f, 25.6f),
                top = vp.vhDp(8.5f, 1.6f, 16f),
                bottom = vp.vhDp(8.5f, 1.6f, 16f),
            ),
        ),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (!solo) {
            Text(
                text = if (res.newPlayer) lateJoinerRank else res.rank?.toString().orEmpty(),
                style = AppType.resultRank.copy(fontSize = rankSize, color = playerCol ?: Tokens.textSecondary),
                modifier = Modifier.widthIn(min = 16.dp), // web min-width 1ch (~24px)
            )
            Spacer(Modifier.width(gap))
        }
        Text(
            text = res.name.ifEmpty { playerFallback },
            style = AppType.resultName.copy(fontSize = rankSize, color = playerCol ?: Tokens.textSecondary),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        Spacer(Modifier.width(gap))
        if (res.newPlayer) {
            Text(
                text = stringResource(R.string.new_player),
                style = statsStyle.copy(fontSize = statsSize, color = Tokens.textSecondary),
            )
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) { // .result-stats gap 1.5rem = 24px (web-px/1.5)
                Text(
                    text = pluralStringResource(R.plurals.n_lines, res.lines ?: 0, res.lines ?: 0),
                    style = statsStyle.copy(fontSize = statsSize, color = Tokens.textSecondary),
                )
                Text(
                    text = stringResource(R.string.level_n, res.level ?: 1),
                    style = statsStyle.copy(fontSize = statsSize, color = Tokens.textSecondary),
                )
            }
        }
    }
}

@Preview(widthDp = 1280, heightDp = 720)
@Composable
private fun ResultsPreview() {
    ResultsScreen(
        results = listOf(
            ResultCard(0, 1, "ALEX", 0, 12, 4),
            ResultCard(1, 2, "SAM", 4, 8, 3),
            ResultCard(2, null, "JORDAN", 6, null, null, newPlayer = true),
        ),
        hostColorIndex = 0,
        onPlayAgain = {},
        onNewGame = {},
    )
}
