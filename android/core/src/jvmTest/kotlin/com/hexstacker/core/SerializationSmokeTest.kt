package com.hexstacker.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals

/** Verifies the kotlinx.serialization plugin + runtime work in this KMP setup
 * (Kotlin 2.3.20). The engine Snapshot/Event/Command models depend on it. */
class SerializationSmokeTest {
    @Serializable
    private data class Probe(val a: Int, val b: List<Int>, val c: List<List<Int>>)

    @Test
    fun roundTrips() {
        val original = Probe(1, listOf(2, 3), listOf(listOf(4, 5), listOf(6)))
        val json = Json.encodeToString(original)
        assertEquals(original, Json.decodeFromString<Probe>(json))
    }
}
