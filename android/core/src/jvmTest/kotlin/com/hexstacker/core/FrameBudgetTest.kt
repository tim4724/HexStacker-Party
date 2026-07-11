package com.hexstacker.core

import com.hexstacker.core.engine.EngineBridge
import com.hexstacker.core.engine.EngineBridge.PlayerSpec
import com.hexstacker.core.engine.InputAction
import com.hexstacker.core.model.EngineConstants
import kotlinx.coroutines.runBlocking
import java.io.File
import java.util.Locale
import kotlin.test.Test
import kotlin.test.assertTrue

/**
 * Measures the worst-case (8-board) `frame()` round trip: QuickJS eval +
 * JSON.stringify in JS + kotlinx decode of the full FrameResult. This is the
 * per-tick cost that bounds the game's effective logic rate, since the
 * main-thread tick loop won't request the next frame until the current round
 * trip returns (the render thread keeps repainting regardless, so only
 * input-to-lock latency degrades, not the visual frame rate).
 *
 * Desktop-JVM numbers, so a TV SoC will be slower. This is a coarse regression
 * guard against the marshalling cost quietly blowing up (snapshot growth, decode
 * regressions), not a device benchmark. The ceiling is the full 60fps budget;
 * steady-state measures far below it, so a failure means something structural.
 */
class FrameBudgetTest {

    private fun bundle(): String {
        val p = System.getProperty("hexcore.bundle") ?: error("hexcore.bundle not set by build")
        return File(p).readText()
    }

    @Test
    fun eightBoardFrameStaysInsideVsyncBudget() = runBlocking {
        val b = EngineBridge.create(bundle())
        try {
            b.createGame(List(8) { PlayerSpec(it, 1) }, seed = 0xC0FFEE)

            val warmup = 120
            val measured = 600
            val samples = DoubleArray(measured)
            var now = 0.0
            for (i in 0 until warmup + measured) {
                // Movement-only inputs (no hard drops): keeps all 8 boards alive for the
                // whole run while the snapshot stays its full constant shape per frame.
                val pid = i % 8
                when (i % 5) {
                    0 -> b.processInput(pid, InputAction.LEFT)
                    1 -> b.processInput(pid, InputAction.RIGHT)
                    2 -> b.processInput(pid, InputAction.ROTATE_CW)
                    else -> Unit
                }
                now += EngineConstants.LOGIC_TICK_MS
                val t0 = System.nanoTime()
                b.frame(now)
                val ms = (System.nanoTime() - t0) / 1e6
                if (i >= warmup) samples[i - warmup] = ms
            }

            samples.sort()
            val avg = samples.average()
            val p50 = samples[measured / 2]
            val p99 = samples[(measured * 99) / 100]
            val max = samples[measured - 1]
            println(
                "8-board frame() round trip over $measured frames: " +
                    String.format(Locale.US, "avg=%.3fms p50=%.3fms p99=%.3fms max=%.3fms", avg, p50, p99, max),
            )

            assertTrue(
                avg < 16.7,
                String.format(Locale.US, "avg 8-board frame round trip %.3fms blows the 60fps budget", avg),
            )
        } finally {
            b.close()
        }
    }
}
