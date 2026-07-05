package com.hexstacker.tv.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.hexstacker.tv.R

// The web legal pages the About screen points phones at. The game is played on
// phones, so the phone the player is already holding is the right screen to read
// long-form legal text on: the TV only offers a scannable link + the URL, and the
// pages themselves stay single-sourced on the web (not re-rendered natively).
private const val PRIVACY_URL = "https://hexstacker.com/privacy"
private const val IMPRINT_URL = "https://hexstacker.com/imprint"

/**
 * About screen (reached from the lobby ⓘ button): two QR cards linking phones to the
 * web Privacy and Imprint pages, plus a focusable row that drills into the Open
 * Source Licenses screen. Back returns to the lobby.
 *
 * Only the licenses row is focusable; the QR cards are display-only (you scan them,
 * you don't select them). Labels reuse the web i18n `privacy` / `imprint` strings and
 * the licenses title, so nothing here is TV-invented copy.
 */
@Composable
fun AboutScreen(
    onOpenLicenses: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val licensesFocus = remember { FocusRequester() }

    Box(modifier.fillMaxSize().background(Tokens.bgPrimary)) {
        BoxWithConstraints(Modifier.fillMaxSize()) {
            val vp = Vp(maxWidth.value, maxHeight.value)
            val overscanH = (vp.wDp * 0.05f).dp // TV title-safe ~5% each edge
            val overscanV = (vp.hDp * 0.05f).dp
            // Card width / gaps mirror the tvOS AboutOverlay metrics (cardW 320px,
            // row gap 96px, cluster gap ~58px at 1080p) so the two TV ports align.
            val cardW = vp.vminDp(180f, 30f, 213.3f)

            // Back hint pinned to the top title-safe edge.
            Text(
                text = stringResource(R.string.licenses_back_hint),
                style = AppType.musicCredit.copy(
                    fontSize = vp.vhSp(18f, 3f, 21.3f),
                    color = Tokens.textFaint,
                ),
                modifier = Modifier.align(Alignment.TopCenter).padding(top = overscanV),
            )

            // Privacy / Imprint QR cards + the licenses button as one vertically
            // centered cluster, so the screen reads as a tight group rather than
            // three elements spread across the whole height.
            Column(
                Modifier.align(Alignment.Center).padding(horizontal = overscanH),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(vp.vhDp(24f, 5.4f, 38.9f)),
            ) {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(vp.vwDp(32f, 6f, 64f)),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    LegalQrCard(
                        label = stringResource(R.string.privacy),
                        url = PRIVACY_URL,
                        vp = vp,
                        modifier = Modifier.width(cardW),
                    )
                    LegalQrCard(
                        label = stringResource(R.string.imprint),
                        url = IMPRINT_URL,
                        vp = vp,
                        modifier = Modifier.width(cardW),
                    )
                }

                ChromeButton(
                    text = stringResource(R.string.licenses_title),
                    primary = false,
                    tint = Tokens.accentPrimary,
                    onClick = onOpenLicenses,
                    focusRequester = licensesFocus,
                    fontSize = vp.vhSp(15f, 2f, 22f),
                )
            }
        }
    }

    // Seat focus on the licenses row so the remote is live on entry and Back is caught.
    LaunchedEffect(Unit) { runCatching { licensesFocus.requestFocus() } }
}

/**
 * One About QR card: a label (Privacy / Imprint), the QR encoding [url] on a
 * full-bleed white panel, and the URL text below. Display-only (not focusable) —
 * the QR is the whole point, so a phone scans it to open the page. The QR is
 * rendered once per URL off-thread (see [rememberQrBitmap]).
 */
@Composable
private fun LegalQrCard(
    label: String,
    url: String,
    vp: Vp,
    modifier: Modifier = Modifier,
) {
    val qr: ImageBitmap? by rememberQrBitmap(url, 480) // crisp at 1080p
    val cardShape = RoundedCornerShape(Tokens.radiusXl)

    Column(
        modifier
            .clip(cardShape)
            .background(Tokens.bgCard, cardShape)
            .border(1.dp, Tokens.border, cardShape)
            .padding(vp.vminDp(10f, 2f, 20f)),
        verticalArrangement = Arrangement.spacedBy(vp.vminDp(8f, 1.5f, 14f)),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = label.uppercase(), // chrome label style, like #qr-label
            style = AppType.qrScanLabel.copy(
                fontSize = vp.vminSp(13f, 1.8f, 18f),
                color = Tokens.textPrimary,
            ),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            textAlign = TextAlign.Center,
        )

        Box(
            Modifier
                .fillMaxWidth()
                .aspectRatio(1f)
                .clip(RoundedCornerShape(Tokens.radiusLg))
                .background(Tokens.white)
                .padding(vp.vminDp(4f, 0.8f, 10f)),
            contentAlignment = Alignment.Center,
        ) {
            if (qr != null) {
                Image(
                    bitmap = qr!!,
                    contentDescription = null, // decorative; the URL text is the equivalent
                    modifier = Modifier.fillMaxSize(),
                    contentScale = ContentScale.Fit,
                )
            }
        }

        Text(
            text = url.removePrefix("https://"),
            style = AppType.joinHost.copy(
                fontSize = vp.vminSp(11f, 1.5f, 15f),
                color = Tokens.textSecondary,
            ),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            textAlign = TextAlign.Center,
        )
    }
}

@Preview(widthDp = 1280, heightDp = 720)
@Composable
private fun AboutPreview() {
    AboutScreen(onOpenLicenses = {})
}
