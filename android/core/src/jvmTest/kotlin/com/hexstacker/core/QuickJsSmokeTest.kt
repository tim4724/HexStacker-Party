package com.hexstacker.core

import com.dokar.quickjs.quickJs
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Spike de-risk: proves quickjs-kt resolves from Maven Central, its native
 * library loads on this desktop JVM (macOS arm64), and arbitrary JS evaluates.
 * If this is green, the "run the canonical engine in QuickJS" thesis holds and
 * we move on to loading the real HexCore bundle through it.
 */
class QuickJsSmokeTest {
    @Test
    fun evaluatesArithmetic() = runBlocking {
        val result = quickJs { evaluate<Int>("1 + 2") }
        assertEquals(3, result)
    }

    @Test
    fun evaluatesString() = runBlocking {
        val result = quickJs { evaluate<String>("'hex' + 'stacker'") }
        assertEquals("hexstacker", result)
    }
}
