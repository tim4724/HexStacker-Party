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
 * Renders a join URL into a QR [ImageBitmap], mirroring the web `renderQR`
 * (DisplayUI.js) and `QRCode.swift` — unstyled black square modules on white,
 * EC level **L**, 1-module quiet zone.
 *
 * Pure ZXing (`com.google.zxing:core`), no Android dependency in the encode step.
 * Generate ONCE per join URL (cached); never on the recomposition path — use
 * [rememberQrBitmap], which encodes off the main thread.
 */
object QrRenderer {

    /** Standard QR dark-module color — plain black, for maximum scan reliability. */
    private const val DARK = 0xFF000000.toInt()
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

        // Unstyled: standard black square modules, edge-to-edge (no inset gap /
        // rounded corners), matching the web renderQR — maximizes scan reliability.
        val paint = Paint().apply { color = dark }

        for (y in 0 until n) {
            for (x in 0 until n) {
                if (matrix.get(x, y).toInt() != 1) continue
                val px = ((x + quiet) * cell).toFloat()
                val py = ((y + quiet) * cell).toFloat()
                canvas.drawRect(px, py, px + cell, py + cell, paint)
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
