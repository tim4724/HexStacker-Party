package com.hexstacker.core

import com.hexstacker.core.engine.EngineBridge
import com.hexstacker.core.engine.EngineBridge.PlayerSpec
import com.hexstacker.core.engine.InputAction
import com.hexstacker.core.model.CommandType
import com.hexstacker.core.model.EngineConstants
import com.hexstacker.core.model.EventType
import kotlinx.coroutines.runBlocking
import java.io.File
import kotlin.test.Test
import kotlin.test.assertTrue

/**
 * Drives a full 2-player game through `frame()` and decodes every FrameResult,
 * proving the typed models survive the entire event/command vocabulary with no
 * unknown-key crash, and that every observed type string is known (catches a
 * vocabulary drift the moment the engine adds a type).
 */
class SnapshotDecodeTest {

    private fun bundle(): String =
        File(System.getProperty("hexcore.bundle") ?: error("hexcore.bundle not set")).readText()

    @Test
    fun decodesFullVocabularyWithoutCrash() = runBlocking {
        val b = EngineBridge.create(bundle())
        try {
            b.createGame(listOf(PlayerSpec(0, 1), PlayerSpec(1, 1)), seed = 0xBADCAFE)
            var now = 0.0
            val seenEvents = mutableSetOf<String>()
            val seenCommands = mutableSetOf<String>()
            var frames = 0
            for (i in 0 until 4000) {
                val pid = i % 2
                when (i % 6) {
                    0 -> b.processInput(pid, InputAction.LEFT)
                    1 -> b.processInput(pid, InputAction.RIGHT)
                    2 -> b.processInput(pid, InputAction.ROTATE_CW)
                    3 -> if (i % 4 == 3) b.processInput(pid, InputAction.HARD_DROP)
                    else -> Unit
                }
                now += EngineConstants.LOGIC_TICK_MS
                val f = b.frame(now) // decodes events + snapshot + commands
                f.events.forEach { seenEvents += it.type }
                f.commands.forEach { seenCommands += it.type }
                frames++
                if (b.isEnded()) break
            }
            assertTrue(frames > 0)
            assertTrue(seenEvents.isNotEmpty(), "a real game produces events")
            assertTrue(
                seenEvents.all { it in EventType.ALL },
                "unknown event types leaked: ${seenEvents - EventType.ALL}",
            )
            assertTrue(
                seenCommands.all { it in CommandType.ALL },
                "unknown command types leaked: ${seenCommands - CommandType.ALL}",
            )
        } finally {
            b.close()
        }
    }
}
