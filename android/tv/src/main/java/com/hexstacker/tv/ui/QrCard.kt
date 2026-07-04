package com.hexstacker.tv.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.hexstacker.tv.R

/**
 * Lobby QR card — QR image + "SCAN TO JOIN" + join-url pill (host over code).
 * Mirrors web `#qr-container`/`#qr-info`/`#join-url` and tvOS `buildQRCard`.
 * The caller sizes the card width via [modifier] (the lobby clamps it to
 * `clamp(180dp, 36vmin, 360dp)`); pass the pre-rendered [qrBitmap] (cached).
 */
@Composable
fun QrCard(
    joinHost: String,
    joinCode: String,
    qrBitmap: ImageBitmap?,
    vp: Vp,
    modifier: Modifier = Modifier,
) {
    val cardShape = RoundedCornerShape(Tokens.radiusXl)
    Column(
        modifier
            .clip(cardShape)
            .background(Tokens.bgCard, cardShape)
            .border(1.dp, Tokens.border, cardShape)
            .padding(vp.vminDp(8f, 1.5f, 18f)),
        verticalArrangement = Arrangement.spacedBy(vp.vminDp(6f, 1f, 12f)),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        // QR image on a full-bleed white rounded panel.
        Box(
            Modifier
                .fillMaxWidth()
                .aspectRatio(1f)
                .clip(RoundedCornerShape(Tokens.radiusLg))
                .background(Tokens.white)
                .padding(vp.vminDp(4f, 0.8f, 10f)),
            contentAlignment = Alignment.Center,
        ) {
            if (qrBitmap != null) {
                Image(
                    bitmap = qrBitmap,
                    contentDescription = null, // decorative; the URL pill is the text equivalent
                    modifier = Modifier.fillMaxSize(),
                    contentScale = ContentScale.Fit,
                )
            }
        }

        // #qr-info — label + join-url pill.
        Column(
            Modifier.fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(vp.vminDp(4f, 0.8f, 8f)),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                text = stringResource(R.string.scan_to_join).uppercase(), // #qr-label text-transform uppercase
                style = AppType.qrScanLabel.copy(
                    fontSize = vp.vminSp(9f, 1.2f, 11f),
                    color = Tokens.textFaint,
                ),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                textAlign = TextAlign.Center,
            )
            Column(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(Tokens.radiusMd))
                    .background(Tokens.joinPillBg)
                    .padding(
                        horizontal = vp.vminDp(8f, 1.5f, 14f),
                        vertical = vp.vminDp(4f, 1f, 8f),
                    ),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(
                    text = joinHost.lowercase(), // .join-url__host text-transform lowercase
                    style = AppType.joinHost.copy(
                        fontSize = vp.vminSp(13.6f, 1.8f, 19.2f), // clamp(0.85rem,1.8vmin,1.2rem)
                        color = Tokens.textSecondary,
                    ),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    textAlign = TextAlign.Center,
                )
                Text(
                    text = joinCode,
                    style = AppType.joinCode.copy(
                        fontSize = vp.vminSp(17.6f, 2.2f, 24f), // clamp(1.1rem,2.2vmin,1.5rem)
                        color = Tokens.accentSecondary,
                    ),
                    maxLines = 1,
                    textAlign = TextAlign.Center,
                )
            }
        }
    }
}
