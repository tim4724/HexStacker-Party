package com.hexstacker.core.room

import com.hexstacker.core.net.RoomState

/**
 * Headless room / lobby / host state machine. A faithful Kotlin port of
 * `partyplug/RoomFlow.js` (the canonical, battle-tested implementation, kept as
 * the parity oracle in `RoomFlowParityTest`). Owns identity, join order,
 * presence and host election; knows nothing about rendering, the relay, or game
 * fields like color/name/score (those are opaque data on the live record).
 *
 * Pure, synchronous, single-writer: no clock reads (liveness takes an injected
 * `nowMs`), no transport, no rendering. Callbacks are Kotlin lambdas (the JS
 * event emitter ported to closures, as the Swift port did).
 *
 * This port follows the JS shape exactly (per-op `prevHost` capture + emit)
 * rather than the Swift `emittingHostChange` wrapper, so the parity oracle holds
 * byte-for-byte.
 */
class RoomFlow(
    /** Platform master (AirConsole). Returns null in relay mode; null disables. */
    private val masterProvider: (() -> Int?)? = null,
    livenessTimeoutMs: Double = Double.POSITIVE_INFINITY,
    graceMs: Double = 0.0,
    /** When it returns false, liveness expiry is suppressed. Read live. */
    private val livenessEnabledProvider: (() -> Boolean)? = null,
) {
    // ---- callbacks (assign as needed; all optional) ----
    var onStateChange: ((from: RoomState, to: RoomState) -> Unit)? = null
    var onPlayerJoin: ((PlayerRecord) -> Unit)? = null
    var onPlayerUpdate: ((PlayerRecord) -> Unit)? = null
    var onPlayerLeave: ((peerIndex: Int) -> Unit)? = null
    var onRosterChange: ((players: List<PlayerRecord>) -> Unit)? = null
    var onHostChange: ((hostPeerIndex: Int?) -> Unit)? = null

    // ---- internal state (mirrors RoomFlow.js exactly) ----
    private val players = LinkedHashMap<Int, PlayerRecord>() // insertion-ordered for stable iteration
    private val disconnected = HashSet<Int>()
    private var order = mutableListOf<Int>()                 // active participant peerIndices
    private var joinSeq = 0
    private var hostSlot: Int? = null                        // backing for hostPeerIndex
    private var roomState = RoomState.LOBBY                  // backing for state

    // liveness
    private val lastSeen = HashMap<Int, Double>()
    private val livenessTimeoutMs = livenessTimeoutMs
    private val graceMs = graceMs
    private var graceDeadline: Double? = null

    // ---- observable state ----
    val state: RoomState get() = roomState
    val hostPeerIndex: Int? get() = hostSlot
    val size: Int get() = players.size
    val connectedCount: Int get() = players.size - disconnected.size

    /**
     * Effective host: platform master (if eligible) -> sticky slot (if eligible)
     * -> oldest-joined eligible present player. Read-only; the sticky slot is only
     * mutated by [removePlayer] / [rekey] / [reconcileStickyHost].
     */
    val host: Int?
        get() {
            val eligible = if (restricted()) order.toHashSet() else null
            masterProvider?.let { mp ->
                val m = mp()
                if (isEligible(m, eligible)) return m
            }
            if (isEligible(hostSlot, eligible)) return hostSlot
            return oldestEligible(eligible, exclude = null)
        }

    companion object {
        /** server/constants.js MAX_PLAYERS. */
        const val MAX_PLAYERS = 8

        /** Lowest free dense slot in [0, max); pass slot values, NOT peerIndices. */
        fun lowestFreeSlot(used: Iterable<Int>, max: Int): Int {
            val taken = used.toHashSet()
            for (i in 0 until max) if (i !in taken) return i
            return -1
        }

        private val VALID_TRANSITIONS: Map<RoomState, List<RoomState>> = mapOf(
            RoomState.LOBBY to listOf(RoomState.COUNTDOWN),
            RoomState.COUNTDOWN to listOf(RoomState.PLAYING, RoomState.LOBBY),
            RoomState.PLAYING to listOf(RoomState.RESULTS, RoomState.LOBBY),
            RoomState.RESULTS to listOf(RoomState.COUNTDOWN, RoomState.LOBBY),
        )
    }

    // =====================================================================
    // Roster
    // =====================================================================

    /** Add a new player or reconnect/refresh an existing one (same peerIndex). */
    fun addPlayer(peerIndex: Int, playerName: String, colorSlot: Int, startLevel: Int = 1): PlayerRecord {
        val existing = players[peerIndex]
        if (existing != null) {
            val prevHost = host
            // Reconnect: refresh game fields + presence; joinedAt preserved.
            existing.playerName = playerName
            existing.colorSlot = colorSlot
            existing.startLevel = startLevel
            existing.connected = true
            disconnected.remove(peerIndex)
            if (host != prevHost) onHostChange?.invoke(host)
            onPlayerUpdate?.invoke(existing)
            onRosterChange?.invoke(list())
            return existing
        }
        val rec = PlayerRecord(peerIndex, joinSeq++, playerName, colorSlot, startLevel)
        rec.connected = true
        players[peerIndex] = rec
        // First joiner owns the sticky host slot (also covers "room emptied then rejoined").
        if (hostSlot == null) {
            hostSlot = peerIndex
            onHostChange?.invoke(host)
        }
        onPlayerJoin?.invoke(rec)
        onRosterChange?.invoke(list())
        return rec
    }

    /** Hard leave (peer_left). Sticky slot only moves on departure in LOBBY/RESULTS. */
    fun removePlayer(peerIndex: Int) {
        if (!players.containsKey(peerIndex)) return
        val prevHost = host
        val wasHost = peerIndex == hostSlot
        players.remove(peerIndex)
        disconnected.remove(peerIndex)
        lastSeen.remove(peerIndex)
        order.remove(peerIndex)
        if (wasHost && (roomState == RoomState.LOBBY || roomState == RoomState.RESULTS)) {
            hostSlot = electNextHost(peerIndex)
        }
        if (host != prevHost) onHostChange?.invoke(host)
        onPlayerLeave?.invoke(peerIndex)
        onRosterChange?.invoke(list())
    }

    /** Cross-device takeover: a different client claims a dropped slot under a new id. */
    fun rekey(oldId: Int, newId: Int): Boolean {
        if (oldId == newId) return false
        val rec = players[oldId] ?: return false
        val prevHost = host
        players.remove(oldId)
        players.remove(newId) // drop the placeholder slot the returning peer got
        // PlayerRecord.peerIndex is val -> create a moved copy preserving joinedAt + game fields.
        val moved = PlayerRecord(newId, rec.joinedAt, rec.playerName, rec.colorSlot, rec.startLevel)
        moved.connected = true
        moved.lastPingTime = rec.lastPingTime
        players[newId] = moved
        disconnected.remove(oldId)
        disconnected.remove(newId)
        // Keep the NEWER of the two last-seen stamps (mirrors partyplug/RoomFlow.js):
        // the placeholder's stamp is the claimant's live signal; the old seat's is up
        // to a reconnect-grace window stale and survives only as a fallback for a
        // never-seen placeholder.
        val keptStamp = listOfNotNull(lastSeen.remove(oldId), lastSeen.remove(newId)).maxOrNull()
        if (keptStamp != null) lastSeen[newId] = keptStamp
        for (i in order.indices) if (order[i] == oldId) order[i] = newId
        if (hostSlot == oldId) hostSlot = newId
        if (host != prevHost) onHostChange?.invoke(host)
        onRosterChange?.invoke(list())
        return true
    }

    /** Soft disconnect window (record stays; presence flips false). */
    fun markDisconnected(peerIndex: Int) {
        val p = players[peerIndex] ?: return
        val prevHost = host
        p.connected = false
        disconnected.add(peerIndex)
        if (host != prevHost) onHostChange?.invoke(host)
        onRosterChange?.invoke(list())
    }

    fun markReconnected(peerIndex: Int) {
        val p = players[peerIndex] ?: return
        val prevHost = host
        p.connected = true
        disconnected.remove(peerIndex)
        if (host != prevHost) onHostChange?.invoke(host)
        onRosterChange?.invoke(list())
    }

    /** Clear every disconnect flag, marking all current players present. */
    fun clearDisconnected(nowMs: Double? = null) {
        // Re-stamp liveness on this "everyone present" transition first (unconditional when nowMs given).
        if (nowMs != null) for (id in players.keys) lastSeen[id] = nowMs
        if (disconnected.isEmpty()) return
        val prevHost = host
        disconnected.clear()
        for (p in players.values) p.connected = true
        if (host != prevHost) onHostChange?.invoke(host)
        onRosterChange?.invoke(list())
    }

    /** Replace the active participant order so host eligibility tracks the game's order. */
    fun setActiveOrder(peerIndices: List<Int>) {
        order = peerIndices.filter { players.containsKey(it) }.toMutableList()
    }

    /** Reset to a fresh room (new room / return to welcome). */
    fun reset() {
        val prevState = roomState
        val hadHost = hostSlot != null
        players.clear()
        disconnected.clear()
        lastSeen.clear()
        graceDeadline = null
        order = mutableListOf()
        hostSlot = null
        joinSeq = 0
        roomState = RoomState.LOBBY
        if (prevState != RoomState.LOBBY) onStateChange?.invoke(prevState, RoomState.LOBBY)
        onRosterChange?.invoke(emptyList())
        if (hadHost) onHostChange?.invoke(null)
    }

    // =====================================================================
    // Lifecycle
    // =====================================================================

    /** Validated state transition. Returns true if applied. */
    fun transitionTo(to: RoomState): Boolean {
        val from = roomState
        if (to == from) return true
        val allowed = VALID_TRANSITIONS[from]
        if (allowed == null || !allowed.contains(to)) return false
        roomState = to
        if (to != RoomState.PLAYING) graceDeadline = null
        if (to == RoomState.COUNTDOWN) snapshotOrder()
        if (to == RoomState.LOBBY) order = mutableListOf()
        if (to == RoomState.LOBBY || to == RoomState.RESULTS) reconcileStickyHost()
        onStateChange?.invoke(from, to)
        return true
    }

    fun endGame(): Boolean = transitionTo(RoomState.RESULTS)
    fun returnToLobby(): Boolean = transitionTo(RoomState.LOBBY)

    // =====================================================================
    // Queries
    // =====================================================================

    fun player(peerIndex: Int): PlayerRecord? = players[peerIndex]
    fun contains(peerIndex: Int): Boolean = players.containsKey(peerIndex)
    fun isDisconnected(peerIndex: Int): Boolean = disconnected.contains(peerIndex)
    fun isHost(peerIndex: Int): Boolean = peerIndex == host

    /** Roster sorted by join order. */
    fun list(): List<PlayerRecord> = players.values.sortedBy { it.joinedAt }

    /** Lowest free color slot (0..MAX_PLAYERS-1), or -1 if the room is full. */
    fun lowestFreeSlot(): Int = lowestFreeSlot(players.values.map { it.colorSlot }, MAX_PLAYERS)

    fun takenColorSlots(): List<Int> = players.values.map { it.colorSlot }.sorted()

    // =====================================================================
    // Host election (DisplayState.getHostPeerIndex / electNextHost / reconcile)
    // =====================================================================

    private fun restricted(): Boolean =
        (roomState == RoomState.COUNTDOWN || roomState == RoomState.PLAYING || roomState == RoomState.RESULTS) &&
            order.isNotEmpty()

    private fun isEligible(idx: Int?, eligibleSet: Set<Int>?): Boolean =
        idx != null && players.containsKey(idx) && !disconnected.contains(idx) &&
            (eligibleSet == null || eligibleSet.contains(idx))

    /** Oldest-joined present player within eligibleSet (null = everyone present), skipping excludeId. */
    private fun oldestEligible(eligibleSet: Set<Int>?, exclude: Int?): Int? {
        var best: Int? = null
        var bestJoin = Int.MAX_VALUE
        for ((id, rec) in players) {
            if (id == exclude) continue
            if (disconnected.contains(id)) continue
            if (eligibleSet != null && !eligibleSet.contains(id)) continue
            if (rec.joinedAt < bestJoin) {
                bestJoin = rec.joinedAt
                best = id
            }
        }
        return best
    }

    private fun electNextHost(exclude: Int?): Int? =
        oldestEligible(if (restricted()) order.toHashSet() else null, exclude)

    private fun reconcileStickyHost() {
        if (players.isEmpty()) return
        val eligible = if (restricted()) order.toHashSet() else null
        val current = hostSlot
        if (current != null && players.containsKey(current) && !disconnected.contains(current) &&
            (eligible == null || eligible.contains(current))
        ) {
            return
        }
        hostSlot = electNextHost(current)
        if (hostSlot != current) onHostChange?.invoke(host)
    }

    private fun snapshotOrder() {
        order = players.values
            .filter { it.connected }
            .sortedBy { it.joinedAt }
            .map { it.peerIndex }
            .toMutableList()
    }

    // =====================================================================
    // Liveness (pure, nowMs-injected predicates; never mutate disconnected, never emit)
    // =====================================================================

    fun onSeen(peerIndex: Int, nowMs: Double) {
        if (players.containsKey(peerIndex)) lastSeen[peerIndex] = nowMs
    }

    fun isExpired(peerIndex: Int, nowMs: Double): Boolean {
        if (livenessEnabledProvider?.invoke() == false) return false
        val seen = lastSeen[peerIndex] ?: return false
        return nowMs - seen > livenessTimeoutMs
    }

    fun expiredPeers(nowMs: Double): List<Int> {
        if (roomState == RoomState.LOBBY) return emptyList()
        val out = mutableListOf<Int>()
        for (id in players.keys) {
            if (disconnected.contains(id)) continue
            if (isExpired(id, nowMs)) out.add(id)
        }
        return out
    }

    fun allParticipantsDisconnected(): Boolean {
        if (order.isEmpty()) return false
        return order.all { disconnected.contains(it) }
    }

    fun hasLateJoiners(): Boolean = players.keys.any { !order.contains(it) }

    fun graceTick(nowMs: Double): Boolean {
        if (roomState == RoomState.PLAYING && allParticipantsDisconnected() && hasLateJoiners()) {
            val deadline = graceDeadline
            if (deadline == null) {
                graceDeadline = nowMs + graceMs
                return false
            }
            if (nowMs >= deadline) {
                graceDeadline = null
                return true
            }
            return false
        }
        graceDeadline = null
        return false
    }
}
