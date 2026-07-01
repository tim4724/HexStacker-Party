package com.hexstacker.tv.render

import android.content.Context
import android.content.res.AssetManager
import android.graphics.Typeface

/**
 * Loads Orbitron (the display face) from `assets/fonts/`, with a monospace
 * fallback that mirrors `getDisplayFont()`'s `'Orbitron' || '"Courier New", monospace'`
 * contract on the web. Weights used: 700 (name / labels / values / timer) and
 * 900 (KO, line-clear popups).
 *
 * The variable TTF is bundled at `assets/fonts/Orbitron[wght].ttf` (the same file
 * the Apple TV port ships). If it fails to load we fall back to monospace so the
 * renderer still draws.
 */
class Fonts(context: Context) {

    private val base: Typeface = loadOrbitron(context.assets)

    /** 600-weight Orbitron — the per-board disconnect / "scan to rejoin" overlay labels. */
    val semibold: Typeface = Typeface.create(base, 600, false)

    /** 700-weight Orbitron — player name, panel labels, stat values, timer. */
    val bold: Typeface = Typeface.create(base, 700, false)

    /** 900-weight Orbitron — KO label and line-clear text popups. */
    val black: Typeface = Typeface.create(base, 900, false)

    /** True when the bundled Orbitron asset loaded (else monospace fallback). */
    val loaded: Boolean = base !== Typeface.MONOSPACE

    private companion object {
        private const val ORBITRON_ASSET = "fonts/Orbitron[wght].ttf"

        fun loadOrbitron(assets: AssetManager): Typeface =
            runCatching { Typeface.createFromAsset(assets, ORBITRON_ASSET) }.getOrNull()
                ?: Typeface.MONOSPACE
    }
}
