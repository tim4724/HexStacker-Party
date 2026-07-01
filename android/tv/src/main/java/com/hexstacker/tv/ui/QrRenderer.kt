package com.hexstacker.tv.ui

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.produceState
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import com.google.zxing.qrcode.encoder.Encoder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlin.math.max

/**
 * Renders a join URL into a rounded-cell QR [ImageBitmap], mirroring the web
 * `renderQR` (DisplayUI.js) look — rounded plum (`--bg-card`) modules on white —
 * and `QRCode.swift` semantics (EC level **L**, 1-module quiet zone).
 *
 * Pure ZXing (`com.google.zxing:core`), no Android dependency in the encode step.
 * Generate ONCE per join URL (cached); never on the recomposition path — use
 * [rememberQrBitmap], which encodes off the main thread.
 */
object QrRenderer {

    /** `--bg-card` rgb(42,37,64) — the web `fillStyle` for QR modules. */
    private const val DARK = 0xFF2A2540.toInt()
    private const val LIGHT = 0xFFFFFFFF.toInt()

    fun render(content: String, sizePx: Int, dark: Int = DARK, light: Int = LIGHT): ImageBitmap {
        val hints = mapOf(
            EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.L,
            EncodeHintType.CHARACTER_SET to "UTF-8",
        )
        val qr = Encoder.encode(content, ErrorCorrectionLevel.L, hints)
        val matrix = qr.matrix // ByteMatrix, no quiet zone
        val n = matrix.width
        val quiet = 1 // server uses a 1-module quiet zone
        val grid = n + quiet * 2
        val cell = max(1, sizePx / grid) // floor, at least 1px/module
        val total = cell * grid

        val bmp = Bitmap.createBitmap(total, total, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bmp)
        canvas.drawColor(light) // white background, full bleed

        val inset = max(0.5f, cell * 0.03f) // renderQR inset = cellPx*0.03
        val radius = max(1f, cell * 0.15f) // renderQR radius = cellPx*0.15
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = dark }

        for (y in 0 until n) {
            for (x in 0 until n) {
                if (matrix.get(x, y).toInt() != 1) continue
                val px = (x + quiet) * cell + inset
                val py = (y + quiet) * cell + inset
                val s = cell - inset * 2
                canvas.drawRoundRect(px, py, px + s, py + s, radius, radius, paint)
            }
        }
        return bmp.asImageBitmap()
    }
}

/**
 * Encodes [content] once (off the main thread) and caches it across recomposition,
 * keyed on the content + target size. Returns null until the first encode lands.
 */
@Composable
fun rememberQrBitmap(content: String, sizePx: Int = 600): State<ImageBitmap?> =
    produceState<ImageBitmap?>(initialValue = null, content, sizePx) {
        value = withContext(Dispatchers.Default) {
            runCatching { QrRenderer.render(content, sizePx) }.getOrNull()
        }
    }
