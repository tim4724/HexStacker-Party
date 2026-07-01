package com.hexstacker.tv.ui

import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.hexstacker.tv.R

/**
 * The host's "Game Music" on/off control (the display-side mute), surfaced in the
 * pause overlay as a full-width focusable settings row: label left, switch right
 * (web `.settings-switch`, tvOS `MusicSwitch`). Switch geometry mirrors the web
 * 52:30 track / 24px thumb / 3px inset. ON → track = host tint, thumb right;
 * OFF → track = white@0.12, thumb left. ON means music is playing.
 *
 * Stateless: [isOn] is owned by the caller; [onToggle] flips it (the integrator
 * calls `remoteToggleMute()` and passes the new value back as [isOn]).
 */
@Composable
fun MusicSwitch(
    isOn: Boolean,
    tint: Color,
    rowHeight: Dp,
    onToggle: () -> Unit,
    modifier: Modifier = Modifier,
    focusRequester: FocusRequester? = null,
) {
    var focused by remember { mutableStateOf(false) }
    val scale by animateFloatAsState(if (focused) 1.03f else 1f, label = "musicSwitchScale")
    val shape = RoundedCornerShape(Tokens.radiusMd)

    val trackH = rowHeight * 0.46f
    val trackW = trackH * (52f / 30f)
    val knobD = trackH * (24f / 30f)
    val margin = trackH * (3f / 30f)
    val thumbX by animateDpAsState(
        targetValue = if (isOn) trackW - margin - knobD else margin,
        label = "musicSwitchThumb",
    )

    Row(
        modifier
            .height(rowHeight)
            .graphicsLayer { scaleX = scale; scaleY = scale }
            .clip(shape)
            .background(if (focused) Tokens.white.copy(alpha = 0.06f) else Color.Transparent, shape)
            .then(if (focused) Modifier.border(4.dp, Tokens.white, shape) else Modifier)
            .then(focusRequester?.let { Modifier.focusRequester(it) } ?: Modifier)
            .onFocusChanged { focused = it.isFocused }
            .focusable()
            .clickable { onToggle() }
            .padding(horizontal = rowHeight * 0.5f),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(
            text = stringResource(R.string.settings_game_music), // NOT uppercased (gotcha #8)
            style = AppType.musicLabel.copy(fontSize = (rowHeight.value * 0.40f).sp, color = Tokens.textPrimary),
        )
        Box(
            Modifier
                .size(width = trackW, height = trackH)
                .clip(RoundedCornerShape(percent = 50))
                .background(if (isOn) tint else Tokens.white.copy(alpha = 0.12f)),
        ) {
            Box(
                Modifier
                    .align(Alignment.CenterStart)
                    .offset(x = thumbX)
                    .size(knobD)
                    .clip(CircleShape)
                    .background(Tokens.white),
            )
        }
    }
}
