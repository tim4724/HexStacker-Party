package com.hexstacker.tv

import android.content.Intent
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Drives the lobby's D-pad focus + the About/Licenses page stack against the
 * real app on a TV emulator (the Android analog of the tvOS
 * UITests/NavigationTests): START holds focus after the entrance, Up reaches
 * the ⓘ, Select pushes About then Licenses then a license's text page, and
 * Back pops one level per press with focus re-seated at every stop.
 *
 * uiautomator (not the Compose test rule) on purpose: it injects real key
 * events through the window and never waits for Compose idleness, which the
 * lobby's infinite ambient animation would stall. Focus regressions are
 * invisible to unit tests and screenshots (a lost D-pad focus renders
 * pixel-identical until a key is pressed); this live loop is what catches them.
 *
 * Back is never pressed at the lobby root: there it exits to the launcher by
 * design, which would end the run.
 */
@RunWith(AndroidJUnit4::class)
class NavigationTest {

    @Test
    fun lobbyFocusAndAboutLicensesNavigation() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val device = UiDevice.getInstance(instrumentation)
        val ctx = instrumentation.targetContext

        ctx.startActivity(
            Intent(ctx, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK),
        )

        // Labels from the app's own resources (ChromeButton uppercases; the
        // emulator locale governs which translation both sides see).
        val waiting = ctx.getString(R.string.waiting_for_players).uppercase()
        val privacy = ctx.getString(R.string.privacy).uppercase()
        val licenses = ctx.getString(R.string.licenses_title).uppercase()

        // Entrance stagger + the deferred focus seed (requestFocus applies once
        // the window gains focus) settle before the first press. The focusable
        // node and its label are separate nodes in the a11y tree (the clickable
        // wrapper carries focus, the Text child carries the string), so focus
        // checks match "focused node with the label as descendant".
        fun focusedWithText(text: String) = By.focused(true).hasDescendant(By.text(text))
        assertTrue("lobby START button not found", device.wait(Until.hasObject(By.text(waiting)), 15_000))
        assertTrue(
            "START must hold focus after the entrance",
            device.wait(Until.hasObject(focusedWithText(waiting)), 5_000),
        )

        // Up reaches the ⓘ; Select pushes About. Asserted via the outcome: if
        // focus were lost (the regression class this test exists for), Select
        // would do nothing and About never opens.
        device.pressDPadUp()
        device.pressDPadCenter()
        assertTrue(
            "About did not open (Up must reach the info button)",
            device.wait(Until.hasObject(By.text(privacy)), 5_000),
        )
        assertTrue(
            "LICENSES must hold focus on About entry",
            device.wait(Until.hasObject(focusedWithText(licenses)), 5_000),
        )

        // Select drills into the Licenses list; the first row (Lunar Joyride,
        // assembleLicenseList leads with the music credit) seats focus, so a
        // further Select opens its text page (the CC BY 3.0 URL fallback).
        device.pressDPadCenter()
        assertTrue("Licenses list did not open", device.wait(Until.hasObject(By.textContains("Lunar Joyride")), 5_000))
        device.pressDPadCenter()
        assertTrue(
            "license text page did not open (first row must hold focus)",
            device.wait(Until.hasObject(By.textContains("creativecommons.org")), 5_000),
        )

        // Back pops one level per press: text -> list -> About -> lobby.
        device.pressBack()
        assertTrue(
            "Back did not pop to the Licenses list",
            device.wait(Until.hasObject(By.textContains("Baloo 2")), 5_000),
        )
        device.pressBack()
        assertTrue("Back did not pop to About", device.wait(Until.hasObject(By.text(privacy)), 5_000))
        assertFalse(
            "Back from Licenses must stop at About, not fall through to the lobby",
            device.hasObject(By.text(waiting)),
        )
        device.pressBack()
        assertTrue("Back did not return to the lobby", device.wait(Until.hasObject(By.text(waiting)), 5_000))
        assertTrue(
            "focus must re-seat on START after the pop",
            device.wait(Until.hasObject(focusedWithText(waiting)), 5_000),
        )
    }
}
