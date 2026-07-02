package com.hexstacker.core.net

import kotlinx.serialization.json.JsonObject

/**
 * Low-latency peer-to-peer controller-input transport (a WebRTC DataChannel), with the
 * relay as fallback. Port of the receiving side of `partyplug/PartyFastlane.js`.
 *
 * The DISPLAY is the receiver/answerer: controllers initiate (create the DataChannel +
 * offer), the display auto-accepts via [handleSignal], decodes inputs, and acks. The
 * display never initiates a connection or sends data packets/heartbeats — it only answers
 * and acks. Signaling `__rtc` envelopes piggyback on the existing relay ([sendSignal]).
 *
 * :core sees only this interface (no `org.webrtc`); the concrete impl lives in :tv, is
 * injected into [DisplayCoordinator], and is null in headless tests (relay-only path).
 */
interface Fastlane {
    /** Handle an inbound `__rtc` signaling envelope (offer / ice) from controller [from]. */
    fun handleSignal(from: Int, data: JsonObject)

    /** Tear down one peer's connection (controller left, or its board was reclaimed). */
    fun close(peerIndex: Int)

    /** Tear down every peer (match end / display shutdown). */
    fun closeAll()

    /**
     * Decoded low-latency inputs — each the full controller message (`{type:'input'|
     * 'soft_drop'|'soft_drop_end', ...}`), delivered in source order. Wired by the
     * coordinator to the SAME path as a relay message so the input handling is identical.
     */
    var onInput: ((from: Int, data: JsonObject) -> Unit)?

    /** Send an `__rtc` signaling envelope (answer / ice) back to controller `to`, via the relay. */
    var sendSignal: ((to: Int, data: JsonObject) -> Unit)?

    companion object {
        /** Envelope key that marks a relay message as fastlane signaling, not an app message. */
        const val RTC_KEY = "__rtc"

        /** True if [data] is a fastlane signaling envelope (route to [handleSignal], not app dispatch). */
        fun isSignal(data: JsonObject): Boolean = RTC_KEY in data
    }
}
