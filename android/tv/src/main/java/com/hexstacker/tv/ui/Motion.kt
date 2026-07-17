package com.hexstacker.tv.ui

import android.content.Context
import android.provider.Settings
import androidx.compose.runtime.staticCompositionLocalOf

/**
 * True when the system asks for animations to be removed. Android has no
 * dedicated reduce-motion flag; the TV accessibility "Remove animations"
 * toggle zeroes the global animator scales, and Compose animations don't
 * honor that scale on their own, hence this explicit local (provided by
 * MainActivity, re-read on every resume).
 *
 * Decorative motion reads this and renders settled: entrance staggers, the
 * join pop, the socket breathe, the countdown pop/beat, the results stagger,
 * the lobby's falling-piece drift. State crossfades (screen swaps, QR dim)
 * and the focus/press feedback stay: fades are the sanctioned reduced-motion
 * fallback and the focus cursor is functional, mirroring the web's
 * prefers-reduced-motion handling and the tvOS Reduce Motion gates.
 *
 * Defaults to false so previews and the Robolectric gallery fixtures keep the
 * production look.
 */
val LocalReduceMotion = staticCompositionLocalOf { false }

/** The system "Remove animations" state (global animator scale zeroed). */
fun systemAnimationsRemoved(context: Context): Boolean =
    Settings.Global.getFloat(
        context.contentResolver,
        Settings.Global.ANIMATOR_DURATION_SCALE,
        1f,
    ) == 0f
