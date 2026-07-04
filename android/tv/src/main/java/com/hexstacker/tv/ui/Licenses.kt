package com.hexstacker.tv.ui

import android.content.Context
import androidx.annotation.RawRes
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import com.hexstacker.tv.R
import com.mikepenz.aboutlibraries.Libs

/**
 * One row of the Open Source Licenses screen: a shipped component and the license it
 * ships under. [body] is the full license text when available, otherwise null — the
 * screen then shows only the license name + [url].
 */
data class LicenseEntry(
    val name: String,
    val author: String?,
    val license: String?,
    val url: String?,
    val body: String?,
)

/**
 * Builds the licenses list once. It is the AboutLibraries-collected dependencies
 * (parsed from res/raw/aboutlibraries.json, generated at build time by the Gradle
 * plugin) plus the non-dependency attributions this app ships that a dependency
 * scan can't see: the MIT QuickJS engine bundled inside quickjs-kt's native library,
 * the Orbitron font (OFL), and the lobby music (CC BY).
 *
 * The Apache-2.0 body — which nearly every dependency uses — is embedded in the
 * report by the plugin. Licenses it couldn't resolve to embedded text (the WebRTC
 * BSD-3-Clause) fall back to a bundled copy in res/raw; anything still missing shows
 * the license name + URL.
 */
@Composable
fun rememberLicenseEntries(): List<LicenseEntry> {
    val context = LocalContext.current
    return remember { buildLicenseEntries(context) }
}

private fun buildLicenseEntries(context: Context): List<LicenseEntry> {
    val json = rawText(context, R.raw.aboutlibraries)
    val libs = Libs.Builder().withJson(json).build()

    val deps = libs.libraries.map { lib ->
        val license = lib.licenses.firstOrNull()
        LicenseEntry(
            name = lib.name.ifBlank { lib.uniqueId },
            author = lib.developers.mapNotNull { it.name }.joinToString()
                .ifBlank { lib.organization?.name },
            license = license?.name,
            url = license?.url,
            body = license?.licenseContent ?: fallbackBody(context, license?.name),
        )
    }.sortedBy { it.name.lowercase() }

    // Attributions that are not Gradle dependencies (so AboutLibraries never sees
    // them) but whose code / assets do ship in the APK.
    val extras = listOf(
        LicenseEntry(
            name = "QuickJS",
            author = "Fabrice Bellard, Charlie Gordon et al.",
            license = "MIT License",
            url = "https://github.com/quickjs-ng/quickjs",
            body = rawText(context, R.raw.license_mit_quickjs),
        ),
        LicenseEntry(
            name = "Orbitron",
            author = "The Orbitron Project Authors",
            license = "SIL Open Font License 1.1",
            url = "https://github.com/theleagueof/orbitron",
            body = rawText(context, R.raw.license_ofl_1_1),
        ),
        LicenseEntry(
            name = "Lunar Joyride",
            author = "FoxSynergy",
            license = "CC BY 3.0",
            url = "https://creativecommons.org/licenses/by/3.0/",
            body = CC_BY_MUSIC,
        ),
    )
    return deps + extras
}

/** Bundled full text for licenses the AboutLibraries report couldn't embed itself. */
private fun fallbackBody(context: Context, licenseName: String?): String? {
    val n = licenseName?.lowercase() ?: return null
    return when {
        "bsd" in n && "3" in n -> rawText(context, R.raw.license_bsd_3_clause)
        else -> null
    }
}

private fun rawText(context: Context, @RawRes id: Int): String =
    context.resources.openRawResource(id).bufferedReader().use { it.readText() }

// CC licenses are canonically referenced by their deed URL rather than a bundled
// legal text; this is the standard CC-BY attribution for the lobby track.
private const val CC_BY_MUSIC =
    "\"Lunar Joyride\" by FoxSynergy\n" +
        "Licensed under Creative Commons Attribution 3.0 Unported (CC BY 3.0)\n" +
        "https://creativecommons.org/licenses/by/3.0/"
