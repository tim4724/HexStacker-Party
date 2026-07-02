package com.hexstacker.core.model

import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * The level -> music playback-rate curve, duplicated from `public/display/Music.js`
 * setSpeed: `0.95 + (Math.min(level, 15) - 1) * (0.4/14)`.
 *
 * These assertions are hand-computed from that formula, NOT cross-engine parity:
 * Music.js is display-side Web Audio (AudioContext/playbackRate) and is not part of the
 * portable core bundle, so there is no QuickJS harness to check it against (unlike the
 * render math in RenderMathParityTest). Kept as a duplicated formula with the values
 * derived inline below. Note Music.js only clamps the HIGH end (`Math.min`); the Lv1
 * floor for level <= 0 is a Kotlin-only guard (musicRateFor uses coerceIn), exercised
 * by the clamp-low cases here.
 */
class EngineConstantsTest {

    @Test
    fun musicRateCurveEndpointsAndClamp() {
        assertEquals(0.95f, EngineConstants.musicRateFor(1), 1e-6f)
        assertEquals(1.35f, EngineConstants.musicRateFor(15), 1e-5f)
        assertEquals(1.35f, EngineConstants.musicRateFor(99), 1e-5f) // clamp high
        assertEquals(0.95f, EngineConstants.musicRateFor(0), 1e-6f)  // clamp low
        assertEquals(0.95f, EngineConstants.musicRateFor(-5), 1e-6f) // clamp low
    }

    @Test
    fun musicRateCurveMidpoint() {
        // Level 8 -> 0.95 + 7 * (0.4/14) = 0.95 + 0.2 = 1.15
        assertEquals(1.15f, EngineConstants.musicRateFor(8), 1e-5f)
    }
}
