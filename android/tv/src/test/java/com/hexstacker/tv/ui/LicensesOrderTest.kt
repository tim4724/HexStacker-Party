package com.hexstacker.tv.ui

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Guards the Open Source Licenses display order produced by [assembleLicenseList]:
 * the app's music and font credits lead, the Gradle dependencies sort alphabetically
 * in the middle, and the bundled QuickJS engine trails. This is the ordering the real
 * screen (buildLicenseEntries) and the screenshot fixture both run through, so a
 * regression here is a real user-visible regression, not a fixture drift.
 */
class LicensesOrderTest {

    private fun entry(name: String) = LicenseEntry(name, author = null, license = null, url = null, body = null)

    @Test
    fun musicAndFontsLeadDepsSortAlphabeticallyQuickJsTrails() {
        val music = entry("Lunar Joyride")
        val fonts = listOf(entry("Baloo 2"), entry("Orbitron"))
        val quickJs = entry("QuickJS")
        // Deliberately out of order, and including names that would sort before the
        // music/font credits if the whole list were sorted flat.
        val deps = listOf(entry("WebRTC SDK"), entry("Compose UI"), entry("AboutLibraries"))

        val ordered = assembleLicenseList(deps, music, fonts, quickJs).map { it.name }

        assertEquals(
            listOf("Lunar Joyride", "Baloo 2", "Orbitron", "AboutLibraries", "Compose UI", "WebRTC SDK", "QuickJS"),
            ordered,
        )
    }

    @Test
    fun leadingCreditsAndTrailingEngineHoldWithNoDeps() {
        val music = entry("Lunar Joyride")
        val fonts = listOf(entry("Baloo 2"), entry("Orbitron"))
        val quickJs = entry("QuickJS")

        val ordered = assembleLicenseList(emptyList(), music, fonts, quickJs).map { it.name }

        assertEquals(listOf("Lunar Joyride", "Baloo 2", "Orbitron", "QuickJS"), ordered)
    }
}
