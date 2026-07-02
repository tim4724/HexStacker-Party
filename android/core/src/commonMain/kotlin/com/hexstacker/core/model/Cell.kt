package com.hexstacker.core.model

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder

/**
 * A board cell / piece block. In the engine JSON this is the 2-element array
 * `[col, row]` (== `[x, y]`), NOT an object, so it needs a custom serializer
 * (mirrors the Swift `init(from:) { unkeyedContainer }`). `blocks: List<Cell>`
 * then decodes a JSON array-of-2-int-arrays directly.
 *
 * Coordinates are VISIBLE-row space (the snapshot already sliced off the spawn
 * buffer and shifted anchors by -BUFFER_ROWS), so `row` can be negative for a
 * piece still partly in the buffer.
 */
@Serializable(with = CellSerializer::class)
data class Cell(val col: Int, val row: Int)

object CellSerializer : KSerializer<Cell> {
    private val delegate = ListSerializer(Int.serializer())
    override val descriptor: SerialDescriptor = delegate.descriptor

    override fun deserialize(decoder: Decoder): Cell {
        val a = delegate.deserialize(decoder)
        require(a.size >= 2) { "Cell expects [col,row], got $a" }
        return Cell(a[0], a[1])
    }

    override fun serialize(encoder: Encoder, value: Cell) =
        delegate.serialize(encoder, listOf(value.col, value.row))
}
