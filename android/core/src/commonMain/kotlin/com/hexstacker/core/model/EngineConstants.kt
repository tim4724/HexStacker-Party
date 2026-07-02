package com.hexstacker.core.model

/**
 * Parity-checked mirror of `server/constants.js`. The engine reads its OWN JS copy
 * (inside the bundle); these Kotlin duplicates let native code and tests reference the
 * same values. Some are read by the Kotlin renderer/coordinator (COLS, VISIBLE_ROWS,
 * TOTAL_ROWS, MAX_PLAYERS, LOGIC_TICK_MS, PIECE_TYPES, PIECE_TYPE_TO_ID); the rest are
 * pure parity mirrors held so the native port pins the full timing/gameplay contract.
 *
 * Every value here is pinned equal to the JS source by `EngineConstantsParityTest`,
 * which loads `server/constants.js` into QuickJS (window.GameConstants), so this file
 * must not drift. `MAX_FRAME_DELTA_MS` is additionally exposed by the shipped bundle as
 * `HexCore.PartyCore.MAX_FRAME_DELTA_MS` (== 50) and is pinned against it too.
 */
object EngineConstants {
    const val COLS = 9
    const val BUFFER_ROWS = 4
    const val VISIBLE_ROWS = 15
    const val TOTAL_ROWS = BUFFER_ROWS + VISIBLE_ROWS // 19
    const val GARBAGE_CELL = 9
    const val MAX_PLAYERS = 8
    const val COUNTDOWN_SECONDS = 3
    const val MAX_SPEED_LEVEL = 15
    const val SOFT_DROP_MULTIPLIER = 20
    const val LOCK_DELAY_MS = 500.0
    const val MAX_LOCK_RESETS = 10
    const val LINE_CLEAR_DELAY_MS = 400.0
    const val MAX_DROPS_PER_TICK = 5
    const val LOGIC_TICK_MS = 1000.0 / 60.0
    const val GARBAGE_DELAY_MS = 2000.0
    const val SOFT_DROP_TIMEOUT_MS = 300.0
    const val HARD_DROP_MIN_INTERVAL_MS = 150.0
    const val MAX_FRAME_DELTA_MS = 50.0

    val PIECE_TYPES = listOf("I3", "V3", "T3", "o", "d", "b")
    val PIECE_TYPE_TO_ID = mapOf("I3" to 1, "V3" to 2, "T3" to 3, "o" to 4, "d" to 5, "b" to 6)

    // GARBAGE_TABLE: single -> 0, double -> 1, triple -> 3.
    val GARBAGE_TABLE = mapOf(1 to 0, 2 to 1, 3 to 3)

    /**
     * Level -> music playback rate: `0.95 + (min(level,15)-1) * (0.4/14)` -> 0.95 (Lv1)..1.35
     * (Lv>=15). Mirrors `public/display/Music.js` setSpeed. Extracted here (pure) so the
     * mapping is unit-testable without ExoPlayer. (Level<=0 clamps to the Lv1 floor.)
     */
    fun musicRateFor(level: Int): Float {
        val clamped = level.coerceIn(1, MAX_SPEED_LEVEL)
        return (0.95 + (clamped - 1) * (0.4 / 14.0)).toFloat()
    }
}
