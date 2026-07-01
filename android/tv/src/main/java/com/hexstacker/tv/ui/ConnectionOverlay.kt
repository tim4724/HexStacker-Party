package com.hexstacker.tv.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.hexstacker.tv.R

/**
 * Full-screen overlay shown when the display's own relay link drops. Mirrors the
 * web: while auto-retrying it reads RECONNECTING / "Connection lost..."; once the
 * client gives up it reads DISCONNECTED with a focusable RECONNECT button. Copy is
 * the web i18n source (no TV-only strings).
 *
 * When [showReconnect] is false (a terminal slot-0 eviction: another display took over
 * the room), the DISCONNECTED copy is shown with no reconnect affordance, mirroring the
 * web dropping the reconnect button in that state.
 */
@Composable
fun ConnectionOverlay(
    disconnected: Boolean,
    onReconnect: () -> Unit = {},
    showReconnect: Boolean = true,
    modifier: Modifier = Modifier,
) {
    val focus = remember { FocusRequester() }

    BoxWithConstraints(
        modifier = modifier
            .fillMaxSize()
            .background(Tokens.overlayBg),
        contentAlignment = Alignment.Center,
    ) {
        val vp = Vp(maxWidth.value, maxHeight.value)
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                text = if (disconnected) stringResource(R.string.disconnected) else stringResource(R.string.reconnecting),
                style = AppType.connHeading,
                color = Tokens.textPrimary,
                fontSize = vp.vwSp(20.8f, 6f, 28.8f), // web .game-overlay h1: clamp(1.3rem,6vw,1.8rem)
            )
            Spacer(Modifier.height(14.dp))
            Text(
                text = stringResource(R.string.connection_lost),
                style = AppType.connStatus,
                color = Tokens.textSecondary,
                fontSize = 14.sp, // web .game-overlay__status: fixed 14px
            )
            if (disconnected && showReconnect) {
                Spacer(Modifier.height(40.dp))
                ChromeButton(
                    text = stringResource(R.string.reconnect),
                    primary = true,
                    tint = Tokens.accentPrimary,
                    onClick = onReconnect,
                    focusRequester = focus,
                )
            }
        }
    }
}
