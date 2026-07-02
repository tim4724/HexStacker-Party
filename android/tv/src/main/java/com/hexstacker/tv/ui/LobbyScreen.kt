package com.hexstacker.tv.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.keyframes
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.hexstacker.tv.R
import kotlinx.coroutines.launch
import kotlin.math.ceil
import kotlin.math.max

/**
 * Full lobby (web `#lobby-screen` / `updatePlayerList`, tvOS `buildLobby`):
 * falling-piece background, HEX STACKER wordmark + PARTY subtitle, QR card,
 * player-card grid, and the host-tinted START button. Stateless — [data] is
 * supplied by the integrator (players pre-sorted by join time); [onStart] fires
 * `remoteStartMatch()`.
 *
 * The QR bitmap is rendered once per join URL off-thread (see [rememberQrBitmap]);
 * pass [qrOverride] to inject a cached/pre-rendered bitmap instead.
 */
@Composable
fun LobbyScreen(
    data: LobbyData,
    onStart: () -> Unit,
    modifier: Modifier = Modifier,
    qrOverride: androidx.compose.ui.graphics.ImageBitmap? = null,
) {
    val startFocus = remember { FocusRequester() }
    val generatedQr by rememberQrBitmap(data.joinUrl) // called unconditionally (Compose rule)
    val qrBitmap = qrOverride ?: generatedQr
    val hasPlayers = data.players.isNotEmpty()

    LaunchedEffect(hasPlayers) {
        if (hasPlayers) runCatching { startFocus.requestFocus() }
    }

    Box(modifier.fillMaxSize().background(Tokens.bgPrimary)) {
        LobbyBackground(Modifier.fillMaxSize(), active = true)

        BoxWithConstraints(Modifier.fillMaxSize()) {
            val vp = Vp(maxWidth.value, maxHeight.value)
            val overscanH = (vp.wDp * 0.05f).dp // TV title-safe ~5% each edge
            val overscanV = (vp.hDp * 0.05f).dp

            Column(
                Modifier.fillMaxSize().padding(horizontal = overscanH, vertical = overscanV),
                verticalArrangement = Arrangement.SpaceEvenly,
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                // Title band — fadeDown.
                EntranceBand(startOffsetY = (-16).dp, durationMs = 600, delayMs = 0) {
                    Wordmark(mainSize = vp.vminSp(25.6f, 7f, 80f))
                }

                // Body band (QR | grid) — fadeUp 0.15s.
                EntranceBand(startOffsetY = 16.dp, durationMs = 600, delayMs = 150) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(vp.vminDp(16f, 3f, 40f)),
                    ) {
                        QrCard(
                            joinHost = data.joinHost,
                            joinCode = data.joinCode,
                            qrBitmap = qrBitmap,
                            vp = vp,
                            modifier = Modifier.width(vp.vminDp(160f, 32f, 320f)),
                        )
                        PlayerGrid(players = data.players, vp = vp)
                    }
                }

                // CTA band — fadeUp 0.45s.
                EntranceBand(startOffsetY = 16.dp, durationMs = 500, delayMs = 450) {
                    val ctaText = if (hasPlayers) {
                        pluralStringResource(R.plurals.start_n_players, data.players.size, data.players.size)
                    } else {
                        stringResource(R.string.waiting_for_players)
                    }
                    ChromeButton(
                        text = ctaText, // uppercased by ChromeButton (.btn text-transform)
                        primary = true,
                        tint = hostTint(data.hostColorIndex),
                        enabled = hasPlayers,
                        focusRequester = startFocus,
                        fontSize = vp.vhSp(16f, 2f, 25.6f), // clamp(1rem,2vh,1.6rem)
                        contentPadding = PaddingValues(
                            horizontal = vp.vwDp(32f, 4f, 96f), // clamp(2rem,4vw,6rem)
                            vertical = vp.vhDp(11.2f, 1.4f, 20.8f), // clamp(0.7rem,1.4vh,1.3rem)
                        ),
                        onClick = onStart,
                    )
                }
            }

            // Music attribution: CC-BY 3.0 credit for "Lunar Joyride" by
            // FoxSynergy (res/raw/lunar_joyride.mp3). Mirrors the web #lobby-footer:
            // small, low-emphasis, pinned to the title-safe bottom edge.
            Text(
                text = stringResource(R.string.music_by),
                style = AppType.musicLabel.copy(
                    fontSize = vp.vwSp(13f, 1.5f, 16f), // clamp(13px,1.5vw,16px)
                    color = Tokens.textSecondary,
                ),
                maxLines = 1,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(bottom = overscanV),
            )
        }
    }
}

/**
 * Player-card grid: packs N players into the first N seats, padded to 4
 * placeholder slots, 2 columns by default and 4 columns at 5+ visible slots
 * (web `.pl--lg`). Filled cards are keyed by `peerIndex` so the join-pop replays
 * only for genuinely new players (the structural analog of `lobbyKnownPlayers`).
 */
@Composable
private fun PlayerGrid(players: List<LobbyPlayer>, vp: Vp) {
    val placeholderSlots = if (vp.wDp >= 2400f) 8 else 4 // web: innerWidth >= 2400 ? 8 : 4 (4K)
    val visibleSlots = max(placeholderSlots, players.size).coerceAtMost(8)
    val cols = if (visibleSlots > 4) 4 else 2
    val rows = ceil(visibleSlots / cols.toFloat()).toInt()
    val cardW = vp.vminDp(150f, 24f, 280f)
    val gap = vp.vminDp(8f, 1.5f, 18f)

    Column(verticalArrangement = Arrangement.spacedBy(gap)) {
        for (row in 0 until rows) {
            Row(horizontalArrangement = Arrangement.spacedBy(gap)) {
                for (col in 0 until cols) {
                    val slot = row * cols + col
                    when {
                        slot >= visibleSlots -> androidx.compose.foundation.layout.Spacer(Modifier.width(cardW))
                        else -> {
                            val player = players.getOrNull(slot)
                            key(player?.peerIndex ?: "empty-$slot") {
                                if (player != null) {
                                    JoinPop { PlayerCard(player, slot, vp, Modifier.width(cardW)) }
                                } else {
                                    PlayerCard(null, slot, vp, Modifier.width(cardW))
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/** slotPopIn: scale 0.6→1.08(60%)→0.96(80%)→1, opacity 0→1, over 0.45s.
 *  Runs once per fresh composition — existing keyed cards never re-pop. */
@Composable
private fun JoinPop(content: @Composable () -> Unit) {
    val scale = remember { Animatable(0.6f) }
    val alpha = remember { Animatable(0f) }
    LaunchedEffect(Unit) {
        launch {
            scale.animateTo(
                1f,
                keyframes {
                    durationMillis = 450
                    0.6f at 0
                    1.08f at 270 // 60%
                    0.96f at 360 // 80%
                    1f at 450
                },
            )
        }
        launch { alpha.animateTo(1f, tween(270)) }
    }
    Box(
        Modifier.graphicsLayer {
            scaleX = scale.value
            scaleY = scale.value
            this.alpha = alpha.value
            // alpha<1 with the default Auto strategy composites into an offscreen buffer
            // that CLIPS to the layer bounds — the 1.08 overshoot would lose its edges
            // mid-pop. ModulateAlpha applies alpha without a buffer (no clipping),
            // matching CSS opacity which never clips.
            compositingStrategy = CompositingStrategy.ModulateAlpha
        },
    ) { content() }
}

/** fadeDown/fadeUp entrance: vertical offset → 0 with alpha 0 → 1, played once. */
@Composable
private fun EntranceBand(
    startOffsetY: Dp,
    durationMs: Int,
    delayMs: Int,
    content: @Composable () -> Unit,
) {
    val anim = remember { Animatable(0f) }
    LaunchedEffect(Unit) {
        anim.animateTo(1f, tween(durationMillis = durationMs, delayMillis = delayMs, easing = FastOutSlowInEasing))
    }
    Box(
        Modifier.graphicsLayer {
            alpha = anim.value
            translationY = startOffsetY.toPx() * (1f - anim.value)
            // No offscreen buffer (see JoinPop): a START button focused during the
            // entrance overflows the band bounds (focus scale + ring) and the Auto
            // strategy's alpha buffer would clip it while it slides in.
            compositingStrategy = CompositingStrategy.ModulateAlpha
        },
    ) { content() }
}

@Preview(widthDp = 1280, heightDp = 720)
@Composable
private fun LobbyPreview() {
    LobbyScreen(
        data = LobbyData(
            joinHost = "play.hexstacker.com/",
            joinCode = "WXYZ",
            joinUrl = "https://play.hexstacker.com/WXYZ",
            players = listOf(
                LobbyPlayer(0, "ALEX", 0, 3),
                LobbyPlayer(1, "SAM", 4, 1),
                LobbyPlayer(2, "JORDAN", 6, 5),
            ),
            hostColorIndex = 0,
        ),
        onStart = {},
    )
}
