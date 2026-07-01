package com.hexstacker.core.model

import kotlinx.serialization.json.Json

/**
 * The configured decoder for all engine JSON (snapshot / frame / events).
 *
 * `ignoreUnknownKeys = true` is MANDATORY: the `game_end` event carries
 * `elapsed`+`results` that the flat [GameEvent] model omits, and it future-proofs
 * the decode against new engine fields. Without it the first game_end throws at
 * decode and kills the frame.
 */
internal object EngineJson {
    val json = Json {
        ignoreUnknownKeys = true
        isLenient = false
        explicitNulls = false
    }
}
