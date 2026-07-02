package com.hexstacker.core.net

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Receiver-side fastlane netcode (display end): implicit-seq dedup + cumulative ack.
 * Mirrors PartyFastlane._handleDataPacket / _sendAck.
 */
class FastlaneReceiverTest {

    private fun input(action: String): JsonObject =
        buildJsonObject { put("type", "input"); put("action", action) }

    private fun dataPacket(ps: Int, t: Double, events: List<JsonObject>): JsonObject =
        buildJsonObject {
            put("ps", ps); put("t", t)
            putJsonArray("h") { events.forEach { add(it) } } // newest-first, per the wire format
        }

    private fun actions(events: List<JsonObject>) = events.map { it["action"]!!.jsonPrimitive.content }

    @Test
    fun appliesEventsInSourceOrderAndAcksHighestSeq() {
        val r = FastlaneReceiver()
        // ps=3, window newest-first [left(es3), rotate(es2), right(es1)].
        val res = r.onDataPacket(dataPacket(3, 100.0, listOf(input("left"), input("rotate_cw"), input("right"))))
        assertEquals(listOf("right", "rotate_cw", "left"), actions(res.events), "oldest-first source order")
        assertEquals(3, r.lastAppliedEs)
        assertEquals(3, res.ack!!["pa"]!!.jsonPrimitive.int)
        assertEquals(100.0, res.ack!!["t"]!!.jsonPrimitive.double, "echoes sender t for its RTT")
    }

    @Test
    fun dedupsRollingWindowResends() {
        val r = FastlaneReceiver()
        r.onDataPacket(dataPacket(2, 1.0, listOf(input("a"), input("b")))) // es2=a, es1=b applied
        // Resend window with one new event: ps=3 -> [c(es3), a(es2), b(es1)]; only c is new.
        val res = r.onDataPacket(dataPacket(3, 2.0, listOf(input("c"), input("a"), input("b"))))
        assertEquals(listOf("c"), actions(res.events))
        assertEquals(3, res.ack!!["pa"]!!.jsonPrimitive.int)
    }

    @Test
    fun heartbeatAppliesNothingButStillAcks() {
        val r = FastlaneReceiver()
        r.onDataPacket(dataPacket(1, 1.0, listOf(input("x")))) // es1 applied
        val hb = buildJsonObject { put("ps", 1); put("t", 9.0); putJsonArray("h") {} }
        val res = r.onDataPacket(hb)
        assertTrue(res.events.isEmpty())
        assertEquals(1, res.ack!!["pa"]!!.jsonPrimitive.int)
        assertEquals(9.0, res.ack!!["t"]!!.jsonPrimitive.double)
    }

    @Test
    fun outOfOrderOlderPacketIsIgnored() {
        val r = FastlaneReceiver()
        r.onDataPacket(dataPacket(5, 1.0, listOf(input("e5"), input("e4")))) // applies es5,es4 -> lastApplied=5
        val res = r.onDataPacket(dataPacket(3, 2.0, listOf(input("e3")))) // es3 <= 5 -> ignored
        assertTrue(res.events.isEmpty())
        assertEquals(5, res.ack!!["pa"]!!.jsonPrimitive.int)
    }

    @Test
    fun ignoresPacketWithoutNumericPsAndDoesNotAck() {
        val r = FastlaneReceiver()
        // A data packet (has `h`) whose `ps` is absent/non-numeric is ignored entirely,
        // with no ack, mirroring PartyFastlane._handleDataPacket's early return before _sendAck.
        val bad = buildJsonObject { put("t", 5.0); putJsonArray("h") { add(input("left")) } }
        val res = r.onDataPacket(bad)
        assertTrue(res.events.isEmpty(), "no events applied")
        assertNull(res.ack, "no ack for a packet without a numeric ps")
        assertEquals(0, r.lastAppliedEs, "lastAppliedEs unchanged")
    }

    @Test
    fun classifiesPacketTypes() {
        assertTrue(FastlaneReceiver.isDataPacket(buildJsonObject { putJsonArray("h") {} }))
        assertFalse(FastlaneReceiver.isDataPacket(buildJsonObject { put("pa", 1) }))
        assertTrue(FastlaneReceiver.isAck(buildJsonObject { put("pa", 1) }))
        assertTrue(Fastlane.isSignal(buildJsonObject { put(FastlaneReceiver.RTC_KEY, "offer") }))
        assertFalse(Fastlane.isSignal(buildJsonObject { put("type", "input") }))
    }
}
