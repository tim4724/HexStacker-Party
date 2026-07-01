package com.hexstacker.core.room

/**
 * A player slot in the room. A reference type (NOT a data class) so game-owned
 * fields can be mutated in place and seen by both [RoomFlow] and the
 * `DisplayCoordinator`, mirroring the shared-record aliasing in the canonical
 * `partyplug/RoomFlow.js` (where `players = flow.players` is the same Map).
 *
 * Kit-owned fields ([peerIndex], [joinedAt], [connected]) are only written by
 * [RoomFlow]; game-owned fields ([playerName], [colorSlot], [startLevel],
 * [lastPingTime]) are written by the coordinator.
 */
class PlayerRecord internal constructor(
    /** Kit-owned, immutable map key (== relay peer index). */
    val peerIndex: Int,
    /** Kit-owned monotonic counter (NOT wall clock); the host-election tiebreak. */
    internal var joinedAt: Int,
    /** Game-owned display name. */
    var playerName: String,
    /** Game-owned dense color slot 0..MAX_PLAYERS-1 (the JS field name is `playerIndex`). */
    var colorSlot: Int,
    /** Game-owned start level, 1..15. */
    var startLevel: Int,
) {
    /** Kit-owned presence flag. */
    var connected: Boolean = true

    /** Game-owned wall-clock-ish ms of the last controller message (diagnostics only). */
    var lastPingTime: Double = 0.0
}
