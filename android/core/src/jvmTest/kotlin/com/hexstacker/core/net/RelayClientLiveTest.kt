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

    /**
     * Home-press lifecycle against the live relay: suspendSocket() is a deliberate
     * close (no auto-reconnect) that keeps the room PINNED, so the foreground
     * reconnect() attempts a `join` of that room. With no other member the relay
     * retired it at active == 0, so the join answers "Room not found" (which is the
     * proof a join was sent, not a create); createFresh() then recovers with a new
     * room, exactly the coordinator's recovery path.
     */
    @Test
    fun suspendKeepsRoomPinnedAndCreateFreshRecovers() {
        if (System.getProperty("hexcore.relay.live") != "1") return // opt-in only

        val created = CountDownLatch(1)
        val rooms = mutableListOf<String>()
        val roomNotFound = CountDownLatch(1)
        val recreated = CountDownLatch(2)

        val client = RelayClient(callbackPoster = { it() })
        client.onCreated = { r, _, _ ->
            synchronized(rooms) { rooms.add(r) }
            created.countDown(); recreated.countDown()
        }
        client.onRelayError = { if (it == "Room not found") roomNotFound.countDown() }
        client.connect()
        assertTrue(created.await(15, TimeUnit.SECONDS), "no 'created' within 15s")

        client.suspendSocket()
        Thread.sleep(1500) // past the first ~1s backoff a NON-deliberate drop would take
        client.reconnect()
        assertTrue(roomNotFound.await(10, TimeUnit.SECONDS), "reconnect did not join the pinned (retired) room")

        client.createFresh()
        assertTrue(recreated.await(15, TimeUnit.SECONDS), "createFresh did not open a fresh room")
        client.shutdown()
        assertTrue(rooms.size == 2 && rooms[0] != rooms[1], "expected two distinct rooms, got $rooms")
    }

    /**
     * Room teardown against the live relay: closeRoom() deletes the room; our own
     * socket is closed with 4001 "room closed", which must unpin the dead room so
     * the auto-reconnect opens a FRESH one via `create` (never a join bouncing off
     * "Room not found").
     */
    @Test
    fun closeRoomGets4001AndRecreatesFresh() {
        if (System.getProperty("hexcore.relay.live") != "1") return // opt-in only

        val rooms = mutableListOf<String>()
        val createdTwice = CountDownLatch(2)
        val errors = mutableListOf<String>()

        val client = RelayClient(callbackPoster = { it() })
        client.onCreated = { r, _, _ ->
            synchronized(rooms) { rooms.add(r) }
            createdTwice.countDown()
        }
        client.onRelayError = { synchronized(errors) { errors.add(it) } }
        client.connect()

        // First created -> close the room; the 4001 close drives the recreate.
        Thread { // close from a helper thread once the first room exists
            while (synchronized(rooms) { rooms.isEmpty() }) Thread.sleep(50)
            client.closeRoom()
        }.start()

        assertTrue(createdTwice.await(25, TimeUnit.SECONDS), "no fresh room after close_room (errors=$errors)")
        client.shutdown()
        assertTrue(synchronized(errors) { "Room not found" !in errors }, "4001 must unpin the room, not rejoin it: $errors")
        assertTrue(rooms.size == 2 && rooms[0] != rooms[1], "expected two distinct rooms, got $rooms")
    }
}
