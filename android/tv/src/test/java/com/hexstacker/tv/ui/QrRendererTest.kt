package com.hexstacker.tv.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.test.junit4.createComposeRule
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.GraphicsMode

/**
 * Guards the QR cache semantics behind the lobby's module fade: the FIRST
 * composition for content the cache has already rendered must get the bitmap
 * synchronously (QrBlock's `animateFloatAsState` then starts at full alpha and
 * the fade does not replay on an About/Licenses return), while new content
 * starts null and lands async (the fade plays for a bitmap that arrives with
 * a delay, e.g. fresh room creation).
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class QrRendererTest {

    @get:Rule
    val compose = createComposeRule()

    @Test
    fun cachedContentIsAvailableOnFirstComposition() {
        val url = "https://example.com/qr-cache-test-${System.nanoTime()}"
        var attached by mutableStateOf(true)
        val firstFrameValues = mutableListOf<ImageBitmap?>()
        var seenForThisAttach = false
        var latest: ImageBitmap? = null

        compose.setContent {
            if (attached) {
                val qr by rememberLobbyQrBitmap(url, 100)
                latest = qr
                if (!seenForThisAttach) {
                    seenForThisAttach = true
                    firstFrameValues += qr
                }
            }
        }
        compose.waitForIdle()

        // Cold cache: the first composition sees null (the encode is async).
        assertNull("new content must start null (async encode)", firstFrameValues[0])

        // Let the off-main encode land (Dispatchers.Default work is outside
        // waitForIdle's view) so the cache is populated before the detach.
        compose.waitUntil(5_000) { latest != null }

        // Detach and re-attach the composable: a fresh composition for the SAME
        // content (the About-return shape). The cache must serve the bitmap to
        // the very first frame.
        attached = false
        compose.waitForIdle()
        seenForThisAttach = false
        attached = true
        compose.waitForIdle()

        assertNotNull(
            "cached content must be available on the first composition (no fade replay)",
            firstFrameValues[1],
        )
    }

    /** Content changing while the composition stays alive (the lobby's URL going
     *  from the pre-room fallback to the real join URL) must re-render:
     *  produceState's state holder survives the key change, so a stale bitmap
     *  for the OLD content must never satisfy the new one (the base-URL QR bug). */
    @Test
    fun contentChangeRerendersInsideLiveComposition() {
        val urlA = "https://example.com/a-${System.nanoTime()}"
        val urlB = "$urlA/with-a-much-longer-room-path"
        var content by mutableStateOf(urlA)
        var latest: ImageBitmap? = null

        compose.setContent {
            val qr by rememberLobbyQrBitmap(content, 100)
            latest = qr
        }
        compose.waitUntil(5_000) { latest != null }
        val bitmapA = latest

        content = urlB
        compose.waitForIdle() // apply the write + recompose + relaunch the producer
        compose.waitUntil(5_000) { latest != null && latest !== bitmapA }

        assertNotNull("new content must render", latest)
    }
}
