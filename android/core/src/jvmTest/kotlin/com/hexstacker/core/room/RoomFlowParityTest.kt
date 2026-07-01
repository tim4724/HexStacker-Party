package com.hexstacker.core.room

import com.dokar.quickjs.quickJs
import com.hexstacker.core.net.RoomState
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import java.io.File
import java.util.Random
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * The oracle that pays for decision (c): the Kotlin [RoomFlow] is a port of
 * `partyplug/RoomFlow.js`, so this drives an identical, fixed-seed randomized op
 * stream through BOTH the Kotlin port and the canonical `HexCore.RoomFlow`
 * (loaded from the same `dist/partycore.js` bundle the engine tests use, inside
 * QuickJS) and asserts byte-identical observable state after EVERY op. It fails
 * the build the moment the Kotlin port drifts from the canonical JS.
 *
 * Mirrors [com.hexstacker.core.EngineBundleTest]'s bundle loading + `quickJs {}`
 * DSL. Randomness is seeded with a fixed [Random] (42) for determinism.
 */
class RoomFlowParityTest {

    private fun bundleSource(): String {
        val path = System.getProperty("hexcore.bundle")
            ?: error("hexcore.bundle system property not set by the build")
        val f = File(path)
        require(f.exists()) { "Engine bundle not found at $path. Run `npm run build` at the repo root first." }
        return f.readText()
    }

    @Test
    fun kotlinRoomFlowMatchesHexCoreRoomFlow() = runBlocking {
        val ops = generateOps(seed = 42, n = 4000)
        val kt = RoomFlow(livenessTimeoutMs = 3000.0, graceMs = 5000.0, livenessEnabledProvider = { true })

        quickJs {
            evaluate<Any?>(bundleSource())
            assertEquals(
                "function",
                evaluate<String>("typeof HexCore.RoomFlow"),
                "HexCore.RoomFlow must be exposed by the bundle",
            )
            evaluate<Any?>(
                """
                globalThis.__rf = new HexCore.RoomFlow({
                    liveness: { timeoutMs: 3000, graceMs: 5000, enabledProvider: function(){ return true; } }
                });
                globalThis.__probe = function(now){
                    var rf = globalThis.__rf;
                    var l = rf.list();
                    var list = [];
                    var disc = [];
                    for (var i = 0; i < l.length; i++) {
                        var p = l[i];
                        var cs = (p.colorSlot != null) ? p.colorSlot : ((p.playerIndex != null) ? p.playerIndex : null);
                        list.push([p.peerIndex, p.joinedAt, p.connected, cs]);
                        if (rf.isDisconnected(p.peerIndex)) disc.push(p.peerIndex);
                    }
                    var exp = rf.expiredPeers(now).slice().sort(function(a, b){ return a - b; });
                    var all = rf.allParticipantsDisconnected();
                    var late = rf.hasLateJoiners();
                    var grace = rf.graceTick(now);
                    return JSON.stringify({
                        state: rf.state,
                        host: (rf.host == null ? null : rf.host),
                        hostPeerIndex: (rf.hostPeerIndex == null ? null : rf.hostPeerIndex),
                        size: rf.size,
                        connectedCount: rf.connectedCount,
                        list: list,
                        isDisc: disc,
                        expired: exp,
                        allDisc: all,
                        late: late,
                        grace: grace
                    });
                };
                void 0;
                """.trimIndent(),
            )

            for ((i, op) in ops.withIndex()) {
                op.apply(kt, op.nowMs)
                // Append `void 0` so the statement's completion value is undefined: ops like
                // addPlayer/rekey/transitionTo otherwise return a JS object/boolean that the
                // bridge would needlessly try to marshal.
                evaluate<Any?>("${op.jsCall} void 0;")
                val js = evaluate<String>("__probe(${op.nowMs})")
                val ktState = ktProbe(kt, op.nowMs)
                assertEquals(js, ktState, "divergence after step $i: ${op.desc}")
            }
        }
        Unit
    }

    /** Build the SAME canonical JSON the JS `__probe` emits, in the SAME key order. */
    private fun ktProbe(rf: RoomFlow, now: Double): String = buildJsonObject {
        put("state", rf.state.wire)
        put("host", rf.host)
        put("hostPeerIndex", rf.hostPeerIndex)
        put("size", rf.size)
        put("connectedCount", rf.connectedCount)
        putJsonArray("list") {
            for (p in rf.list()) {
                add(
                    buildJsonArray {
                        add(p.peerIndex)
                        add(p.joinedAt)
                        add(p.connected)
                        add(p.colorSlot)
                    },
                )
            }
        }
        putJsonArray("isDisc") { for (p in rf.list()) if (rf.isDisconnected(p.peerIndex)) add(p.peerIndex) }
        putJsonArray("expired") { rf.expiredPeers(now).sorted().forEach { add(it) } }
        put("allDisc", rf.allParticipantsDisconnected())
        put("late", rf.hasLateJoiners())
        put("grace", rf.graceTick(now))
    }.toString()

    // ---- op stream ----

    private class Op(
        val desc: String,
        val jsCall: String,
        val nowMs: Double,
        // nowMs is passed in (NOT captured from the generator's mutable `now`, which a
        // closure would read at its final value — the bug the oracle first surfaced).
        val apply: (RoomFlow, nowMs: Double) -> Unit,
    )

    private fun generateOps(seed: Long, n: Int): List<Op> {
        val rnd = Random(seed)
        val states = listOf(RoomState.LOBBY, RoomState.COUNTDOWN, RoomState.PLAYING, RoomState.RESULTS)
        val ops = ArrayList<Op>(n)
        var now = 0.0
        repeat(n) {
            now += rnd.nextInt(1500).toDouble()
            val roll = rnd.nextInt(100)
            val op = when {
                roll < 25 -> {
                    val idx = rnd.nextInt(7); val slot = rnd.nextInt(8); val lvl = 1 + rnd.nextInt(15)
                    Op("add($idx,$slot,$lvl)", "__rf.addPlayer($idx,{playerName:'p$idx',colorSlot:$slot,startLevel:$lvl});", now) { rf, _ ->
                        rf.addPlayer(idx, "p$idx", slot, lvl)
                    }
                }
                roll < 37 -> {
                    val idx = rnd.nextInt(7)
                    Op("remove($idx)", "__rf.removePlayer($idx);", now) { rf, _ -> rf.removePlayer(idx) }
                }
                roll < 49 -> {
                    val idx = rnd.nextInt(7)
                    Op("markDisc($idx)", "__rf.markDisconnected($idx);", now) { rf, _ -> rf.markDisconnected(idx) }
                }
                roll < 59 -> {
                    val idx = rnd.nextInt(7)
                    Op("markReconn($idx)", "__rf.markReconnected($idx);", now) { rf, _ -> rf.markReconnected(idx) }
                }
                roll < 71 -> {
                    val idx = rnd.nextInt(7)
                    Op("onSeen($idx,$now)", "__rf.onSeen($idx,$now);", now) { rf, nowMs -> rf.onSeen(idx, nowMs) }
                }
                roll < 81 -> {
                    val s = states[rnd.nextInt(4)]
                    Op("transition(${s.wire})", "__rf.transitionTo('${s.wire}');", now) { rf, _ -> rf.transitionTo(s) }
                }
                roll < 87 -> {
                    val ids = randomSubset(rnd, 7)
                    Op("setOrder($ids)", "__rf.setActiveOrder([${ids.joinToString(",")}]);", now) { rf, _ -> rf.setActiveOrder(ids) }
                }
                roll < 93 -> Op("clearDisc($now)", "__rf.clearDisconnected($now);", now) { rf, nowMs -> rf.clearDisconnected(nowMs) }
                roll < 97 -> {
                    val o = rnd.nextInt(7); val nw = 7 + rnd.nextInt(5)
                    Op("rekey($o,$nw)", "__rf.rekey($o,$nw);", now) { rf, _ -> rf.rekey(o, nw) }
                }
                else -> Op("reset()", "__rf.reset();", now) { rf, _ -> rf.reset() }
            }
            ops.add(op)
        }
        return ops
    }

    private fun randomSubset(rnd: Random, max: Int): List<Int> {
        val items = (0 until max).toMutableList()
        for (i in items.indices.reversed()) {
            val j = rnd.nextInt(i + 1)
            val t = items[i]; items[i] = items[j]; items[j] = t
        }
        return items.take(rnd.nextInt(max + 1))
    }
}
