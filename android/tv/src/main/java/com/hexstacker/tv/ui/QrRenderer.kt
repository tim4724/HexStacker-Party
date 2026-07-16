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
 * Encodes [content] once per composition (off the main thread). Returns null
 * until the encode lands. Used by the About legal cards, which have no fade
 * tied to arrival; the lobby uses [rememberLobbyQrBitmap].
 *
 * Rendered modules-only (transparent background): these bitmaps sit on an opaque
 * white Compose card that supplies the light background, and a white-bled bitmap
 * fading in over the card mid-entrance reads as a second white square (the tvOS
 * QR double-fade bug; tvOS renders with `.multiply` for the same reason).
 */
@Composable
fun rememberQrBitmap(content: String, sizePx: Int = 600): State<ImageBitmap?> =
    produceState<ImageBitmap?>(initialValue = null, content, sizePx) {
        value = withContext(Dispatchers.Default) {
            runCatching { QrRenderer.render(content, sizePx, light = 0x00000000) }.getOrNull()
        }
    }

// The lobby join QR's last render — a single slot, because one lobby QR exists
// at a time. No generic cache: this exists solely so QrBlock's module fade
// (animateFloatAsState, which only animates on change) does not replay when a
// page swap back to the lobby (About/Licenses pop, results -> NEW GAME)
// re-composes the SAME join URL; a new room's URL mismatches and re-renders
// async, which is exactly the delayed arrival the fade is for.
private var lobbyQrKey: Pair<String, Int>? = null
private var lobbyQrBitmap: ImageBitmap? = null

/** [rememberQrBitmap] plus the single-slot last-render cache for the lobby:
 *  unchanged content is served synchronously to the FIRST composition. */
@Composable
fun rememberLobbyQrBitmap(content: String, sizePx: Int = 600): State<ImageBitmap?> {
    val key = content to sizePx
    return produceState(initialValue = lobbyQrBitmap.takeIf { lobbyQrKey == key }, content, sizePx) {
        // produceState's state holder SURVIVES key changes (only this producer
        // restarts), so never gate on `value` — it may hold the PREVIOUS
        // content's bitmap (the lobby URL changes from the pre-room fallback to
        // the real join URL). Always resolve THIS key: slot hit, else render.
        val cached = lobbyQrBitmap.takeIf { lobbyQrKey == key }
        value = cached ?: withContext(Dispatchers.Default) {
            runCatching { QrRenderer.render(content, sizePx, light = 0x00000000) }.getOrNull()
        }?.also {
            lobbyQrKey = key
            lobbyQrBitmap = it
        }
    }
}
