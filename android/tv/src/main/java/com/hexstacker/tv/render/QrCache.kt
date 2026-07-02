package com.hexstacker.tv.render

import android.graphics.Bitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import com.hexstacker.tv.ui.QrRenderer

/**
 * Encodes join-URLs to QR [Bitmap]s for the per-board disconnect overlay, cached per
 * URL. Render-thread only. Delegates to the shared [QrRenderer] so the rejoin QR gets
 * the SAME branded look as the lobby QR and the web `renderQR` (rounded `--bg-card`
 * plum modules on white, EC level L, 1-module quiet zone) rather than plain black
 * squares. The bitmap is rendered at a fixed module resolution and scaled to the
 * board's QR box at draw time.
 */
internal class QrCache(private val sidePx: Int = 320) {

    private val cache = HashMap<String, Bitmap>()

    fun get(url: String): Bitmap? {
        cache[url]?.let { return it }
        val bmp = runCatching { QrRenderer.render(url, sidePx).asAndroidBitmap() }.getOrNull() ?: return null
        cache[url] = bmp
        return bmp
    }

    fun clear() {
        for (b in cache.values) b.recycle()
        cache.clear()
    }
}
