package com.hexstacker.tv.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.hexstacker.tv.R

/**
 * Open Source Licenses screen (reached from the lobby footer). A single
 * D-pad-focusable, scrolling list — one focusable row per shipped component; select
 * (DPAD center) toggles the full license text open in place. Back / Menu returns to
 * the lobby via [onClose].
 *
 * The prebuilt AboutLibraries Compose UI is a mobile/touch Material list, so this
 * renders its own list in the app's brand/token design language instead, driven
 * by plain [LicenseEntry] data (see [rememberLicenseEntries]). Legal body text uses
 * a monospace family — display faces are unreadable at that length.
 *
 * Stateless: [entries] is supplied by the caller so screenshot tests can pass a
 * fixed fixture without loading the generated report.
 */
@Composable
fun LicensesScreen(
    entries: List<LicenseEntry>,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val firstRow = remember { FocusRequester() }

    Box(
        modifier
            .fillMaxSize()
            .background(Tokens.bgPrimary)
            // Menu closes the screen; Back is owned by the app-level BackHandler (see
            // MainActivity) so it routes through the OnBackPressedDispatcher — a manual
            // Back key handler here double-fired and finished the Activity. Preview phase
            // so Menu wins before a focused row; DPAD/select fall through to the row.
            .onPreviewKeyEvent { ev ->
                if (ev.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                when (ev.key) {
                    Key.Menu -> { onClose(); true }
                    else -> false
                }
            },
    ) {
        BoxWithConstraints(Modifier.fillMaxSize()) {
            val vp = Vp(maxWidth.value, maxHeight.value)
            val overscanH = (vp.wDp * 0.05f).dp // TV title-safe ~5% each edge
            val overscanV = (vp.hDp * 0.05f).dp

            Column(Modifier.fillMaxSize().padding(horizontal = overscanH, vertical = overscanV)) {
                Text(
                    text = stringResource(R.string.licenses_title),
                    style = AppType.wordmarkMain.copy(
                        fontSize = vp.vhSp(22f, 3f, 34f),
                        color = Tokens.textPrimary,
                    ),
                )
                Text(
                    text = stringResource(R.string.licenses_back_hint),
                    style = AppType.musicCredit.copy(
                        fontSize = vp.vhSp(18f, 3f, 21.3f),
                        color = Tokens.textFaint,
                    ),
                    modifier = Modifier.padding(top = 4.dp, bottom = 12.dp),
                )

                LazyColumn(
                    Modifier.fillMaxSize(),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    itemsIndexed(entries, key = { i, e -> "${e.name}#$i" }) { index, entry ->
                        LicenseRow(
                            entry = entry,
                            modifier = if (index == 0) Modifier.focusRequester(firstRow) else Modifier,
                        )
                    }
                }
            }
        }
    }

    // Seat focus on the first row so the remote is live on entry and Back is caught.
    androidx.compose.runtime.LaunchedEffect(Unit) {
        if (entries.isNotEmpty()) runCatching { firstRow.requestFocus() }
    }
}

/** A focusable, expand-in-place license row. Focus highlights it; select toggles the body. */
@Composable
private fun LicenseRow(entry: LicenseEntry, modifier: Modifier = Modifier) {
    var focused by remember { mutableStateOf(false) }
    var expanded by remember { mutableStateOf(false) }
    val shape = RoundedCornerShape(Tokens.radiusMd)

    Column(
        modifier
            .fillMaxWidth()
            .clip(shape)
            .background(if (focused) Tokens.bgCard else Tokens.bgSecondary, shape)
            .border(
                width = if (focused) 2.dp else 1.dp,
                color = if (focused) Tokens.white else Tokens.border,
                shape = shape,
            )
            .onFocusChanged { focused = it.isFocused }
            .clickable { expanded = !expanded }
            .padding(horizontal = 20.dp, vertical = 14.dp),
    ) {
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = entry.name,
                style = AppType.resultName.copy(fontSize = 18.sp, color = Tokens.textPrimary),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            entry.license?.let {
                Text(
                    text = it,
                    style = AppType.musicCredit.copy(fontSize = 13.sp, color = Tokens.textSecondary),
                    maxLines = 1,
                )
            }
        }
        entry.author?.takeIf { it.isNotBlank() }?.let {
            Text(
                text = it,
                style = AppType.musicCredit.copy(fontSize = 12.sp, color = Tokens.textFaint),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = 2.dp),
            )
        }
        if (expanded) {
            Text(
                text = entry.body ?: entry.url ?: "",
                style = androidx.compose.ui.text.TextStyle(
                    fontFamily = FontFamily.Monospace,
                    fontSize = 12.sp,
                    color = Tokens.textSecondary,
                ),
                modifier = Modifier.padding(top = 12.dp),
            )
        }
    }
}

@Preview(widthDp = 1280, heightDp = 720)
@Composable
private fun LicensesPreview() {
    LicensesScreen(
        entries = listOf(
            LicenseEntry("Compose UI", "The Android Open Source Project", "Apache License 2.0", null, "Apache text..."),
            LicenseEntry("WebRTC SDK", "The WebRTC project authors", "The 3-Clause BSD License", null, "BSD text..."),
            LicenseEntry("Orbitron", "The Orbitron Project Authors", "SIL Open Font License 1.1", null, "OFL text..."),
            LicenseEntry("Lunar Joyride", "FoxSynergy", "CC BY 3.0", null, "Music credit..."),
        ),
        onClose = {},
    )
}
