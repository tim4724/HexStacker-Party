package com.hexstacker.core.net

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put

/** New input events (source order) + the ack to send back, from one inbound packet. */
data class FastlaneReceived(
    val events: List<JsonObject>,
    /** The `{pa, t}` ack to reply with, or null when the packet was ignored (no numeric `ps`). */
    val ack: JsonObject?,
)

/**
 * Receiver-side (display) netcode for ONE fastlane peer. Pure + platform-free so it is
 * unit-testable without WebRTC. Port of `PartyFastlane._handleDataPacket` + `_sendAck`.
 *
 * The sender resends a short rolling window over an unreliable, unordered DataChannel;
 * per-event seq is implicit (`es[i] = ps - i`, newest first). We apply only events with
 * `es > lastAppliedEs` (dedup) and always reply with a cumulative ack `{pa, t}` (echoing
 * the sender's `t` so IT can estimate RTT). The display never sends data packets/heartbeats.
 */
class FastlaneReceiver {

    /** Highest event seq applied so far (cumulative). */
    var lastAppliedEs: Int = 0
        private set

    /** Process a parsed inbound DATA packet `{ps, t, h:[...]}`. Returns new events + ack. */
    fun onDataPacket(packet: JsonObject): FastlaneReceived {
        val ps = (packet["ps"] as? JsonPrimitive)?.intOrNull
        // Mirror PartyFastlane._handleDataPacket: a data packet without a numeric `ps` is
        // ignored entirely, with no ack (the JS returns before _sendAck).
        if (ps == null) return FastlaneReceived(emptyList(), null)
        val h = packet["h"] as? JsonArray ?: JsonArray(emptyList())
        val out = ArrayList<JsonObject>(h.size)
        // Events arrive newest-first; iterate oldest-first so the sink sees source order.
        for (i in h.size - 1 downTo 0) {
            val es = ps - i
            if (es > lastAppliedEs) {
                lastAppliedEs = es
                (h[i] as? JsonObject)?.let { out.add(it) }
            }
        }
        return FastlaneReceived(out, buildAck(packet))
    }

    private fun buildAck(packet: JsonObject): JsonObject = buildJsonObject {
        put("pa", lastAppliedEs)
        (packet["t"] as? JsonPrimitive)?.doubleOrNull?.let { put("t", it) }
    }

    companion object {
        /** The signaling envelope key (`{__rtc:'offer'|'answer'|'ice', ...}`). */
        const val RTC_KEY = "__rtc"

        /** A data packet carries `h` (events / heartbeat); an ack carries `pa`. */
        fun isDataPacket(packet: JsonObject): Boolean = "h" in packet
        fun isAck(packet: JsonObject): Boolean = "pa" in packet
    }
}
