package com.hexstacker.tv.ui

import androidx.compose.ui.Modifier
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.type

/**
 * Context-key mapping for the TV remote, decoupled from the (not-yet-existing)
 * coordinator. DPAD arrows + DPAD_CENTER/ENTER are intentionally NOT handled
 * here — they fall through to the native Compose focus engine (focusable buttons
 * activate on center/enter). Only the media/menu/back context keys are mapped,
 * mirroring tvOS `GameViewController.pressesBegan` + `RootScene.remote*`.
 *
 * Attach to the root via `Modifier.onRemoteKeys(...)` (use `onKeyEvent`, not
 * `onPreviewKeyEvent`, so focusable children consume DPAD first). The callbacks
 * return `true` when the key was consumed; the integrator decides behavior from
 * the current room state (e.g. PlayPause = start / play-again / pause-resume;
 * Menu during play = toggle pause + consume, otherwise let it bubble).
 *
 * Back is deliberately NOT mapped here: it must route through the
 * OnBackPressedDispatcher (a `BackHandler`) so a single Back can't both toggle
 * pause AND finish the Activity. Consuming Back as a raw key event does not
 * suppress the dispatcher's default finish(), which is the exit-mid-game bug.
 *
 * Backstop: some TV remotes deliver MEDIA_PLAY_PAUSE only to `Activity.onKeyDown`,
 * bypassing Compose — the integrator should also route those there to
 * [onPlayPause], guarding against double-fire.
 */
fun Modifier.onRemoteKeys(
    onPlayPause: () -> Boolean,
    onMenu: () -> Boolean,
): Modifier = this.onKeyEvent { ev ->
    if (ev.type != KeyEventType.KeyDown) return@onKeyEvent false
    // Act on the first press only; a held key auto-repeats KeyDown, which would
    // otherwise toggle pause/start repeatedly. Repeats on a mapped key are still
    // consumed (return true) so they don't leak to the default handler.
    val firstPress = ev.nativeKeyEvent.repeatCount == 0
    when (ev.key) {
        Key.MediaPlayPause, Key.MediaPlay, Key.MediaPause, Key.P -> if (firstPress) onPlayPause() else true
        Key.Menu -> if (firstPress) onMenu() else true
        else -> false // DPAD + Center/Enter -> native focus engine; Back -> BackHandler
    }
}
