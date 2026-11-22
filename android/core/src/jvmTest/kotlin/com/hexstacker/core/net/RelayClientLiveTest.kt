package com.hexstacker.core.net

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.test.Test
import kotlin.test.assertEquals
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

    /**
     * Slot 0 is held by the secret minted at create, not a guessable constant: a
     * stranger holding only the room code who joins as the old "display" id lands in
     * a slot of its own instead of evicting us (close 4000). Our own suspend/resume
     * still rejoins slot 0, which the stranger sees as peer_left/peer_joined index 0.
     */
    @Test
    fun strangerWithTheRoomCodeCannotTakeSlot0AndResumeStillRejoinsIt() {
        if (System.getProperty("hexcore.relay.live") != "1") return // opt-in only

        val created = CountDownLatch(1)
        val room = AtomicReference<String?>(null)
        val instance = AtomicReference<String?>(null)
        val replaced = CountDownLatch(1)
        val client = RelayClient(callbackPoster = { it() })
        client.onCreated = { r, inst, _ -> room.set(r); instance.set(inst); created.countDown() }
        client.onReplaced = { replaced.countDown() }
        client.connect()
        assertTrue(created.await(15, TimeUnit.SECONDS), "no 'created' within 15s")

        val frames = LinkedBlockingQueue<JsonObject>()
        val http = OkHttpClient()
        val url = instance.get()?.let { "${RelayConfig.RELAY_URL}/${room.get()}?instance=$it" } ?: RelayConfig.RELAY_URL
        val stranger = http.newWebSocket(
            Request.Builder().url(url).build(),
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    webSocket.send("""{"type":"join","clientId":"display","room":"${room.get()}"}""")
                }
                override fun onMessage(webSocket: WebSocket, text: String) {
                    frames.add(RelayJson.parseToJsonElement(text).jsonObject)
                }
            },
        )
        fun next(type: String): JsonObject? {
            while (true) {
                val f = frames.poll(10, TimeUnit.SECONDS) ?: return null
                if (f["type"]?.jsonPrimitive?.contentOrNull == type) return f
            }
        }
        fun JsonObject?.index() = this?.get("index")?.jsonPrimitive?.intOrNull

        val joined = next("joined")
        assertTrue(joined != null && joined.index() != 0, "stranger must not get slot 0: $joined")
        assertTrue(!replaced.await(2, TimeUnit.SECONDS), "the display was evicted by a guessed clientId")

        client.suspendSocket()
        assertEquals(0, next("peer_left").index(), "suspend vacates slot 0")
        client.reconnect()
        assertEquals(0, next("peer_joined").index(), "resume rejoins slot 0 with the minted secret")

        stranger.close(1000, null)
        http.dispatcher.executorService.shutdown()
        client.shutdown()
    }

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
