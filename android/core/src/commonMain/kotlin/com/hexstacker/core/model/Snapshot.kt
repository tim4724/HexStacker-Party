package com.hexstacker.core.model

import kotlinx.serialization.Serializable

/**
 * Value-copy snapshot mirroring `PartyCore.snapshot()` (== `Game.getSnapshot()`
 * deep-copied by `PartyCore.copyPlayer`). Safe to retain across frames.
 *
 * The grid is VISIBLE-row space: 15 rows x 9 cols, top-to-bottom, `grid[row][col]`,
 * 0 = empty else the piece typeId (1..6, or GARBAGE_CELL=9).
 */
@Serializable
data class GameSnapshot(
    val players: List<PlayerState>,
    val elapsed: Double,
)

@Serializable
data class PlayerState(
    val id: Int,                                 // == relay peer index
    val grid: List<List<Int>>,                   // grid[row][col], 15 x 9
    val currentPiece: Piece? = null,             // null mid line-clear / after death
    val ghost: Ghost? = null,
    val holdPiece: String? = null,               // piece-type name, or null
    val nextPieces: List<String> = emptyList(),  // next up-to-3 type names
    val level: Int,
    val lines: Int,
    val alive: Boolean,
    val pendingGarbage: Int,                     // board-pending + delayed GarbageManager queue
    val clearingCells: List<Cell>? = null,       // cells mid clear-anim, or null
    val gridVersion: Int,                        // dirty flag; copy snapshot only on change
)

@Serializable
data class Piece(
    val type: String,        // "I3","V3","T3","o","d","b"
    val typeId: Int,         // 1..6, also the grid cell value
    val anchorCol: Int,
    val anchorRow: Int,      // VISIBLE coords; CAN be negative (still in spawn buffer)
    val cells: List<Axial> = emptyList(),  // axial {q,r} offsets
    val blocks: List<Cell> = emptyList(),  // absolute visible-coord cells to render
)

@Serializable
data class Ghost(
    val typeId: Int? = null, // == currentPiece.typeId (color source); null when no piece
    val anchorCol: Int,
    val anchorRow: Int,
    val blocks: List<Cell> = emptyList(),  // hard-drop landing preview
)

@Serializable
data class Axial(val q: Int, val r: Int)
