package com.hexstacker.tv.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
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
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.hexstacker.core.render.Theme
import com.hexstacker.tv.R
import kotlinx.coroutines.delay

/**
 * Results overlay (web `renderResults` / `#results-screen`, tvOS `buildResults`).
 * Sits over the host chrome's lobby backdrop (brand fill + falling-piece ambient,
 * opaque over the frozen boards: web `#bg-canvas.over-game`) and adds only the
 * winner's radial glow. Three bands centered as a group: the HEX STACKER wordmark,
 * the standings, PLAY AGAIN + NEW GAME; the triad badge takes the lobby's corner.
 * The PLAY AGAIN primary CTA is host-tinted (web `applyHostTint`). No anti-misclick
 * gate on the TV (a couch remote, not a phone): buttons are live and focusable
 * immediately.
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
    // Baked once per size like the lobby vignette (see GlowCache): the drifting
    // pieces beneath damage the full screen every frame.
    val glow = remember(winnerGlow) { GlowCache(winnerGlow, stop = 0.6f) }

    val playAgainFocus = remember { FocusRequester() }
    // Buttons are live immediately — no anti-misclick gate on the TV. Grab D-pad
    // focus for the primary CTA on entry.
    LaunchedEffect(Unit) { playAgainFocus.requestFocus() }

    // Buttons fade in with the list (web .result-actions fade, matching the 0.4s
    // row stagger duration; no per-row delay). Reduce Motion shows them settled
    // (web results.css forces this gate open under prefers-reduced-motion).
    val reduceMotion = LocalReduceMotion.current
    val buttonsEnter = remember { Animatable(if (reduceMotion) 1f else 0f) }
    if (!reduceMotion) LaunchedEffect(Unit) { buttonsEnter.animateTo(1f, tween(400)) }

    BoxWithConstraints(modifier.fillMaxSize().drawBehind { drawGlow(glow) }) {
        val vp = Vp(maxWidth.value, maxHeight.value)
        // #results-table: rows share the ~53vh the title, header and buttons leave,
        // capped at 13.3vh / 11.3vw so 1-4 players don't balloon; gap 1.9vh, 1.1vh
        // at 5+ rows. Stat columns are statW wide, statGap apart and inset.
        val n = maxOf(1, sorted.size)
        val gap = vp.hDp * if (n > 4) 0.011f else 0.019f
        val rowH = minOf(vp.hDp * 0.133f, vp.wDp * 0.113f, (vp.hDp * 0.53f - (n - 1) * gap) / n)
        val statW = maxOf(vp.hDp * 0.11f, rowH * 1.4f)
        val statGap = rowH * 0.2f
        Column(
            Modifier
                .fillMaxSize()
                .padding(horizontal = vp.vwDp(16f, 3f, 32f), vertical = (vp.hDp * 0.044f).dp),
            verticalArrangement = Arrangement.spacedBy(vp.vhDp(24f, 7.8f, 88f), Alignment.CenterVertically),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Wordmark(mainSize = vp.vminSp(25.6f, 6f, 70.4f)) // #results-screen h1 clamp(1.6rem,6vmin,4.4rem)

            Column(
                Modifier.width(minOf(vp.wDp * 0.9f, vp.hDp * 1.05f).dp), // min(90vw, 105vh)
                verticalArrangement = Arrangement.spacedBy((vp.hDp * 0.012f).dp),
            ) {
                ResultsHead(statW, statGap, font = maxOf(vp.px(12f).value, vp.hDp * 0.0167f, rowH * 0.19f)) // max(0.75rem, 1.67vh, row-h*0.19)
                Column(verticalArrangement = Arrangement.spacedBy(gap.dp)) {
                    sorted.forEachIndexed { i, res ->
                        // Keyed like LobbyScreen's PlayerGrid: late joiners append to `sorted` at
                        // runtime, and the key keeps each row's entrance Animatable with its player.
                        key(res.playerId) {
                            ResultRow(res = res, index = i, solo = solo, rowH = rowH, statW = statW, statGap = statGap, vp = vp)
                        }
                    }
                }
            }

            Row(
                Modifier.graphicsLayer {
                    alpha = buttonsEnter.value
                    // No offscreen buffer (see LobbyScreen's EntranceBand): PLAY AGAIN
                    // is focused during this fade and its ring + 1.06 scale overflow
                    // the Row bounds, which the Auto strategy's alpha buffer clips.
                    compositingStrategy = CompositingStrategy.ModulateAlpha
                },
                horizontalArrangement = Arrangement.spacedBy(vp.vwDp(12.8f, 1.5f, 24f)),
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
                    minWidth = vp.vhDp(260f, 34f, 420f),
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
                    minWidth = vp.vhDp(260f, 34f, 420f),
                    onClick = onNewGame,
                )
            }
        }

        // Triad corner badge, placed and faded exactly like the lobby's.
        val overscan = Theme.Size.tvOverscan.toFloat()
        BadgeFadeIn(
            Modifier
                .align(Alignment.TopStart)
                .padding(top = (vp.hDp * overscan).dp, start = (vp.wDp * overscan).dp),
        ) {
            TriadMark(Modifier.size(vp.vminDp(40f, 6.4f, 80f)))
        }
    }
}

/**
 * The LINES / LEVEL header (web `.results-head`): labels centred over the row values,
 * which sit in [statW]-wide columns [statGap] apart and [statGap] in from the row's
 * right edge (web `--stat-w` / `--stat-gap`).
 */
@Composable
private fun ResultsHead(statW: Float, statGap: Float, font: Float) {
    Row(
        Modifier.fillMaxWidth().padding(end = statGap.dp),
        horizontalArrangement = Arrangement.spacedBy(statGap.dp, Alignment.End),
    ) {
        listOf(R.string.lines, R.string.level_heading).forEach { id ->
            Text(
                text = stringResource(id).uppercase(),
                style = AppType.cardLevelHeading.copy(fontSize = font.sp, color = Tokens.textSecondary),
                textAlign = TextAlign.Center,
                // The 0.2em start padding balances the trailing letter-spacing so the label centres optically.
                modifier = Modifier.width(statW.dp).padding(start = (font * 0.2f).dp),
            )
        }
    }
}

/**
 * One standings row: the lobby player card's tonal fill (no shadow), with
 * everything sized off the row height [rowH] (web `--row-h`).
 */
@Composable
private fun ResultRow(res: ResultCard, index: Int, solo: Boolean, rowH: Float, statW: Float, statGap: Float, vp: Vp) {
    val shape = RoundedCornerShape(Tokens.radiusCard) // .result-row 20px (A2)
    // Hoisted so they can be used inside non-composable lambdas / branches below.
    val lateJoinerRank = stringResource(R.string.late_joiner_rank) // DisplayUI '–' rank
    val playerFallback = stringResource(R.string.player)
    val playerCol = res.colorIndex?.let { playerColor(it) }
    val font = maxOf(vp.px(16f).value, vp.hDp * 0.025f, rowH * 0.36f) // max(1rem, 2.5vh, row-h*0.36)
    val statsFont = font * 0.85f // .result-stats 0.85em

    // Stagger entrance: fade + slide up, delay 0.2 + i*0.08 s. Reduce Motion
    // renders the row settled (decorative entrance).
    val reduceMotion = LocalReduceMotion.current
    val enter = remember(index) { Animatable(if (reduceMotion) 1f else 0f) }
    if (!reduceMotion) LaunchedEffect(index) {
        delay((200L + index * 80L))
        enter.animateTo(1f, tween(400))
    }

    val base = Modifier
        .fillMaxWidth()
        .height(rowH.dp)
        .graphicsLayer {
            alpha = enter.value * if (res.newPlayer) 0.75f else 1f
            translationY = (1f - enter.value) * 7.5.dp.toPx()
        }

    // Late joiners get the recessed socket treatment (.result-row--joining)
    // instead of the tonal card.
    val card = if (res.newPlayer) {
        base
            .clip(shape)
            .background(Tokens.socketEmpty, shape)
            .border(0.5.dp, Tokens.hairlineFaint, shape)
    } else {
        base
            .clip(shape)
            .background(Tokens.tonalCard(playerCol ?: Tokens.bgCardSoft), shape)
    }

    Row(
        card.padding(start = (rowH * 0.25f).dp, end = statGap.dp),
        horizontalArrangement = Arrangement.spacedBy((rowH * 0.2f).dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (!solo) {
            Text(
                text = if (res.newPlayer) lateJoinerRank else res.rank?.toString().orEmpty(),
                style = AppType.resultRank.copy(
                    fontSize = font.sp,
                    color = playerCol ?: Tokens.textSecondary,
                    fontFeatureSettings = "tnum",
                ),
                textAlign = TextAlign.Center,
                modifier = Modifier.widthIn(min = (font * 1.1f).dp),
            )
        }
        Text(
            text = res.name.ifEmpty { playerFallback },
            // .result-name: the lobby card's identity-name recipe
            style = AppType.cardName.copy(fontSize = font.sp, color = playerCol ?: Tokens.textPrimary),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        if (res.newPlayer) {
            // .result-new: spans both stat columns.
            Text(
                text = stringResource(R.string.new_player),
                style = AppType.resultStats.copy(fontSize = (statsFont * 0.7f).sp, color = Tokens.textSecondary),
                textAlign = TextAlign.Center,
                maxLines = 1,
                softWrap = false,
                modifier = Modifier.width((2 * statW + statGap).dp),
            )
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(statGap.dp)) {
                listOf(res.lines ?: 0, res.level ?: 1).forEach { value ->
                    Text(
                        text = value.toString(),
                        style = AppType.cardLevelValue.copy(
                            fontSize = statsFont.sp,
                            color = Tokens.textPrimary,
                            fontFeatureSettings = "tnum",
                        ),
                        textAlign = TextAlign.Center,
                        maxLines = 1,
                        modifier = Modifier.width(statW.dp),
                    )
                }
            }
        }
    }
}

@Preview(widthDp = 960, heightDp = 540)
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
