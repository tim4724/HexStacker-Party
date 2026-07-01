package com.hexstacker.core.engine

import com.dokar.quickjs.QuickJs
import com.hexstacker.core.model.EngineJson
import com.hexstacker.core.model.FrameResult
import com.hexstacker.core.model.GameEvent
import com.hexstacker.core.model.GameSnapshot
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * Typed Kotlin surface over the canonical HexStacker game engine running in
 * QuickJS. The Android analogue of `appletv/.../Engine/EngineBridge.swift`,
 * driving the SAME canonical server engine (bundled to `dist/partycore.js`)
 * through `PartyCore.frame(nowMs)`. Does NOT re-port game logic.
 *
 * Threading: the QuickJS C runtime is single-threaded. The instance is created on
 * a serial [dispatcher]; every public method is `suspend` and guarded by a [Mutex]
 * so two `evaluate` calls can never overlap on the one shared mutable `Game`. Route
 * the frame loop and controller input through the same coordinator coroutine so
 * input accumulates between frames exactly as the web does.
 *
 * One bridge lives for the whole app: `createGame()` re-inits a fresh game per
 * match (the JS `Bridge.create` reassigns `core`) without re-parsing the bundle.
 */
class EngineBridge private constructor(
    private val qjs: QuickJs,
    private val dispatcher: CoroutineDispatcher,
) {
    private val lock = Mutex()

    companion object {
        /**
         * Build a ready bridge: create QuickJS on [dispatcher], evaluate the engine
         * bundle (defines `globalThis.HexCore`) + the Bridge shim, verify both exist.
         *
         * @param bundleJs full text of `dist/partycore.js` (asset on device, file in tests)
         * @param dispatcher a SERIAL dispatcher; defaults to a private limitedParallelism(1)
         */
        suspend fun create(
            bundleJs: String,
            dispatcher: CoroutineDispatcher = Dispatchers.Default.limitedParallelism(1),
        ): EngineBridge {
            val qjs = QuickJs.create(dispatcher)
            try {
                qjs.evaluate<Any?>(bundleJs)                          // -> globalThis.HexCore
                qjs.evaluate<Any?>(EngineBootstrap.SHIM + "\nvoid 0;") // -> globalThis.Bridge
                if (qjs.evaluate<String>("typeof HexCore.PartyCore") != "function") {
                    throw EngineException.BridgeUnavailable
                }
                if (qjs.evaluate<String>("typeof Bridge") != "object") {
                    throw EngineException.BridgeUnavailable
                }
            } catch (e: Throwable) {
                qjs.close()
                throw EngineException.wrap("bootstrap", e)
            }
            return EngineBridge(qjs, dispatcher)
        }
    }

    // --- game control --------------------------------------------------------

    /** Construct + init() a new game. [players] order fixes snapshot order. */
    suspend fun createGame(players: List<PlayerSpec>, seed: Long): Unit = lock.withLock {
        val specs = players.joinToString(",", "[", "]") { "[${it.id},${it.startLevel}]" }
        eval("create", "Bridge.create($specs, $seed)")
    }

    /** Discrete input: left|right|rotate_cw|hard_drop|hold (hard_drop locks synchronously). */
    suspend fun processInput(playerId: Int, action: InputAction): Unit = lock.withLock {
        eval("processInput", "Bridge.processInput($playerId, '${action.wire}')")
    }

    suspend fun softDropStart(playerId: Int, speed: Int? = null): Unit = lock.withLock {
        val call = if (speed == null) "Bridge.softDropStart($playerId)"
        else "Bridge.softDropStart($playerId, $speed)"
        eval("softDropStart", call)
    }

    suspend fun softDropEnd(playerId: Int): Unit = lock.withLock {
        eval("softDropEnd", "Bridge.softDropEnd($playerId)")
    }

    /** Granular tick (demo/frozen capture). The live loop uses [frame] instead. */
    suspend fun update(deltaMs: Double): Unit = lock.withLock {
        eval("update", "Bridge.update(${jsNum(deltaMs)})")
    }

    suspend fun pause(): Unit = lock.withLock { eval("pause", "Bridge.pause()") }
    suspend fun resume(): Unit = lock.withLock { eval("resume", "Bridge.resume()") }

    /**
     * Cross-device claim: rekey the engine's per-player state (board, garbage queue,
     * cooldown) from [oldId] to [newId] so a returning controller's inputs hit the
     * reclaimed board. Returns true if a board moved. Mirrors `PartyCore.rekey`.
     */
    suspend fun rekey(oldId: Int, newId: Int): Boolean = lock.withLock {
        try {
            qjs.evaluate<Boolean>("Bridge.rekey($oldId, $newId)")
        } catch (e: Throwable) {
            throw EngineException.wrap("rekey", e)
        }
    }

    /**
     * Forget the previous frame() timestamp; the next frame() re-primes with
     * deltaMs=0. MUST be called whenever leaving the active loop (pause, results).
     * Mirrors the web `prevFrameTime = 0` reset.
     */
    suspend fun resetFrameClock(): Unit = lock.withLock {
        eval("resetFrameClock", "Bridge.resetFrameClock()")
    }

    suspend fun isEnded(): Boolean = lock.withLock {
        try {
            qjs.evaluate<Boolean>("Bridge.isEnded()")
        } catch (e: Throwable) {
            throw EngineException.wrap("isEnded", e)
        }
    }

    // --- reads ---------------------------------------------------------------

    suspend fun snapshot(): GameSnapshot = lock.withLock {
        decode("snapshotJSON", "Bridge.snapshotJSON()")
    }

    suspend fun drainEvents(): List<GameEvent> = lock.withLock {
        decode("drainEventsJSON", "Bridge.drainEventsJSON()")
    }

    /**
     * The blessed native integration surface. Caps nowMs->deltaMs, ticks the engine
     * (self-gating on paused/ended), returns this frame's events + value-copy snapshot
     * + normalized host commands.
     *
     * @param nowMs monotonic ms; only deltas matter, origin is free.
     */
    suspend fun frame(nowMs: Double): FrameResult = lock.withLock {
        decode("frameJSON", "Bridge.frameJSON(${jsNum(nowMs)})")
    }

    /**
     * Close the QuickJS runtime. `suspend` + [lock] so it can never overlap an
     * in-flight frame()/input call, and frees the thread-confined C runtime on the
     * engine [dispatcher] thread that created it (never the caller's, e.g. Main).
     */
    suspend fun close() = lock.withLock { withContext(dispatcher) { qjs.close() } }

    // --- internals -----------------------------------------------------------

    private suspend fun eval(label: String, code: String) {
        try {
            qjs.evaluate<Any?>(code)
        } catch (e: Throwable) {
            throw EngineException.wrap(label, e)
        }
    }

    private suspend inline fun <reified T> decode(label: String, code: String): T {
        val json = try {
            qjs.evaluate<String>(code)
        } catch (e: Throwable) {
            throw EngineException.wrap(label, e)
        }
        return try {
            // Parse OFF the coordinator's (Main) dispatcher: the per-frame snapshot JSON (up
            // to 8 boards) is pure to deserialize and touches no coordinator state, so moving
            // it to Default keeps the frame parse from competing with UI/input on the main thread.
            withContext(Dispatchers.Default) { EngineJson.json.decodeFromString<T>(json) }
        } catch (e: Throwable) {
            throw EngineException.decode(label, e)
        }
    }

    data class PlayerSpec(val id: Int, val startLevel: Int = 1)
}

/**
 * Emit a JS-valid numeric literal. Kotlin `Double.toString()` is locale-invariant
 * (always `.`, never grouping; `E` notation which JS accepts), so it is safe; we
 * only guard non-finite so a glitch never injects `NaN`/`Infinity` into a script.
 */
internal fun jsNum(d: Double): String = if (d.isFinite()) d.toString() else "0"
