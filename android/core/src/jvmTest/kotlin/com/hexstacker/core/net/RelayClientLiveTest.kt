package com.hexstacker.core.net

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.test.Test
import kotlin.test.assertTrue

/**
 * End-to-end smoke test against the LIVE Party-Server relay (wss://ws.hexstacker.com):
 * connect, create a fresh room, assert we receive a `created` frame with a room code.
 * Proves the Android RelayClient emits frames the real relay accepts (the third peer
 * alongside the web + Apple TV).
 *
 * Opt-in (needs network + relay up), so it no-ops in normal/offline CI:
 *   ./gradlew :core:jvmTest -Dhexcore.relay.live=1
 */
class RelayClientLiveTest {

    @Test
    fun createsARoomOnLiveRelay() {
        if (System.getProperty("hexcore.relay.live") != "1") return // opt-in only

        val latch = CountDownLatch(1)
        val room = AtomicReference<String?>(null)
        val instance = AtomicReference<String?>(null)
        val errors = mutableListOf<String>()

        val client = RelayClient(callbackPoster = { it() })
        client.onCreated = { r, inst, _ ->
            room.set(r); instance.set(inst); latch.countDown()
        }
        client.onRelayError = { errors.add(it) }
        client.connect()

        val gotCreated = latch.await(15, TimeUnit.SECONDS)
        client.shutdown()

        assertTrue(gotCreated, "no 'created' within 15s (errors=$errors)")
        val r = room.get()
        assertTrue(!r.isNullOrBlank(), "room code was blank")
        println("[relay-live] created room=$r instance=${instance.get()}")
    }
}
