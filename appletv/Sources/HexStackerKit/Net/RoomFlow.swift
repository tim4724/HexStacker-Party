import Foundation

/// A player slot in the room. A reference type so game-owned fields can be
/// mutated in place and seen by both RoomFlow and the coordinator, mirroring
/// the shared-record aliasing in the JS implementation.
public final class PlayerRecord {
    public let peerIndex: Int
    public var joinedAt: Int           // monotonic counter (not wall clock)
    public var connected: Bool
    // Game-owned fields (RoomFlow never reads these for its own logic):
    public var playerName: String
    public var colorSlot: Int          // dense 0..MAX_PLAYERS-1 (JS: playerIndex)
    public var startLevel: Int         // 1...15

    init(peerIndex: Int, joinedAt: Int, playerName: String, colorSlot: Int, startLevel: Int) {
        self.peerIndex = peerIndex
        self.joinedAt = joinedAt
        self.connected = true
        self.playerName = playerName
        self.colorSlot = colorSlot
        self.startLevel = startLevel
    }
}

/// Headless room / lobby / host state machine. Ported from partyplug/RoomFlow.js.
/// Owns identity, presence and host election; knows nothing about rendering or
/// the relay. The display (coordinator) drives transitions and reads `host`.
public final class RoomFlow {

    // Event callbacks (the kit's tiny pub/sub, as closures).
    public var onStateChange: ((_ from: RoomState, _ to: RoomState) -> Void)?
    public var onPlayerJoin: ((PlayerRecord) -> Void)?
    public var onPlayerUpdate: ((PlayerRecord) -> Void)?
    public var onPlayerLeave: ((_ peerIndex: Int) -> Void)?
    public var onRosterChange: ((_ players: [PlayerRecord]) -> Void)?
    public var onHostChange: ((_ hostPeerIndex: Int?) -> Void)?

    /// Platform master provider (AirConsole). Returns nil in relay mode.
    public var masterProvider: (() -> Int?)?

    public private(set) var state: RoomState = .lobby
    /// Raw sticky host slot (may differ from effective `host` during a blip).
    public private(set) var hostPeerIndex: Int?

    private var players: [Int: PlayerRecord] = [:]
    private var disconnected: Set<Int> = []
    private var order: [Int] = []
    private var joinSeq = 0

    // Liveness (presence-timeout) + late-joiner grace. Clock-free: every method is
    // a pure predicate the host calls with an injected nowMs (mirrors the canonical
    // partyplug/RoomFlow.js). Detectors never mutate `disconnected` — the host
    // applies a detected expiry through markDisconnected, preserving single-writer.
    private var lastSeen: [Int: Double] = [:]
    private let livenessTimeoutMs: Double
    private let graceMs: Double
    private var graceDeadline: Double?

    public init(livenessTimeoutMs: Double = 3000, graceMs: Double = 5000) {
        self.livenessTimeoutMs = livenessTimeoutMs
        self.graceMs = graceMs
    }

    private static let validTransitions: [RoomState: [RoomState]] = [
        .lobby: [.countdown],
        .countdown: [.playing, .lobby],
        .playing: [.results, .lobby],
        .results: [.countdown, .lobby],
    ]

    // MARK: - Transitions

    @discardableResult
    public func transition(to: RoomState) -> Bool {
        let from = state
        if to == from { return true }
        guard Self.validTransitions[from]?.contains(to) == true else {
            return false   // invalid transition (JS warns and returns false)
        }
        emittingHostChange {
            state = to
            if to == .countdown { snapshotOrder() }
            if to == .lobby { order = [] }
            if to != .playing { graceDeadline = nil }   // a stale deadline must not fire in the next game
            if to == .lobby || to == .results { reconcileStickyHost() }
        }
        onStateChange?(from, to)
        return true
    }

    public func endGame() { transition(to: .results) }
    public func returnToLobby() { transition(to: .lobby) }

    // MARK: - Roster

    /// Add a new player or refresh an existing one (reconnect). Returns the record.
    @discardableResult
    public func addPlayer(peerIndex: Int, playerName: String, colorSlot: Int, startLevel: Int = 1) -> PlayerRecord {
        if let existing = players[peerIndex] {
            // Mutate inside the wrapper so a host-eligibility change (a sticky
            // host regaining `connected`) actually emits (JS captures prevHost
            // before the mutations).
            emittingHostChange {
                existing.playerName = playerName
                existing.colorSlot = colorSlot
                existing.startLevel = startLevel
                existing.connected = true            // joinedAt preserved
                disconnected.remove(peerIndex)
            }
            onPlayerUpdate?(existing)
            onRosterChange?(list())
            return existing
        }
        let rec = PlayerRecord(peerIndex: peerIndex, joinedAt: joinSeq, playerName: playerName,
                               colorSlot: colorSlot, startLevel: startLevel)
        joinSeq += 1
        players[peerIndex] = rec
        // First joiner owns the sticky host slot.
        if hostPeerIndex == nil {
            hostPeerIndex = peerIndex
            onHostChange?(host)
        }
        onPlayerJoin?(rec)
        onRosterChange?(list())
        return rec
    }

    public func removePlayer(_ peerIndex: Int) {
        guard players[peerIndex] != nil else { return }
        emittingHostChange {
            let wasHost = peerIndex == hostPeerIndex
            players.removeValue(forKey: peerIndex)
            disconnected.remove(peerIndex)
            lastSeen.removeValue(forKey: peerIndex)
            order.removeAll { $0 == peerIndex }
            // Sticky slot only moves on departure in LOBBY/RESULTS.
            if wasHost, state == .lobby || state == .results {
                hostPeerIndex = electNextHost(exclude: peerIndex)
            }
        }
        onPlayerLeave?(peerIndex)
        onRosterChange?(list())
    }

    /// Cross-device takeover: a different client claims a dropped slot under a
    /// new peer index. Returns false if not applicable.
    @discardableResult
    public func rekey(oldId: Int, newId: Int) -> Bool {
        guard oldId != newId, let rec = players[oldId] else { return false }
        emittingHostChange {
            players.removeValue(forKey: oldId)
            players.removeValue(forKey: newId)   // drop placeholder slot
            // PlayerRecord.peerIndex is immutable; create a moved copy.
            let moved = PlayerRecord(peerIndex: newId, joinedAt: rec.joinedAt, playerName: rec.playerName,
                                     colorSlot: rec.colorSlot, startLevel: rec.startLevel)
            moved.connected = true
            players[newId] = moved
            disconnected.remove(oldId)
            disconnected.remove(newId)
            // Keep the NEWER of the two last-seen stamps (mirrors partyplug/RoomFlow.js):
            // the placeholder's stamp is the claimant's live signal; the old seat's is up
            // to a reconnect-grace window stale and survives only as a fallback for a
            // never-seen placeholder.
            let keptStamp = [lastSeen.removeValue(forKey: oldId), lastSeen.removeValue(forKey: newId)]
                .compactMap { $0 }.max()
            if let keptStamp { lastSeen[newId] = keptStamp }
            order = order.map { $0 == oldId ? newId : $0 }
            if hostPeerIndex == oldId { hostPeerIndex = newId }
        }
        onRosterChange?(list())
        return true
    }

    public func markDisconnected(_ peerIndex: Int) {
        guard let p = players[peerIndex] else { return }
        emittingHostChange {
            p.connected = false
            disconnected.insert(peerIndex)
        }
        onRosterChange?(list())
    }

    public func markReconnected(_ peerIndex: Int) {
        guard let p = players[peerIndex] else { return }
        emittingHostChange {
            p.connected = true
            disconnected.remove(peerIndex)
        }
        onRosterChange?(list())
    }

    public func clearDisconnected() {
        guard !disconnected.isEmpty else { return }
        emittingHostChange {
            disconnected.removeAll()
            for (_, p) in players { p.connected = true }
        }
        onRosterChange?(list())
    }

    /// Replace the active participant order (the game's player order) so host
    /// eligibility is restricted to current participants during a round.
    public func setActiveOrder(_ peerIndices: [Int]) {
        emittingHostChange {
            order = peerIndices.filter { players[$0] != nil }
        }
    }

    public func reset() {
        let hadHost = hostPeerIndex != nil
        let prevState = state
        players.removeAll()
        disconnected.removeAll()
        lastSeen.removeAll()
        graceDeadline = nil
        order = []
        hostPeerIndex = nil
        joinSeq = 0
        state = .lobby
        if prevState != .lobby { onStateChange?(prevState, .lobby) }
        onRosterChange?([])
        if hadHost { onHostChange?(nil) }
    }

    // MARK: - Queries

    public var size: Int { players.count }
    public var connectedCount: Int { players.count - disconnected.count }
    public func player(_ peerIndex: Int) -> PlayerRecord? { players[peerIndex] }
    public func contains(_ peerIndex: Int) -> Bool { players[peerIndex] != nil }
    public func isDisconnected(_ peerIndex: Int) -> Bool { disconnected.contains(peerIndex) }

    // MARK: - Liveness / presence timeout (ported from partyplug/RoomFlow.js)

    /// Record that we just heard from a peer (a controller message / rejoin).
    /// Ignores unknown peers so a stray packet can't resurrect a stamp.
    public func onSeen(_ peerIndex: Int, _ nowMs: Double) {
        if players[peerIndex] != nil { lastSeen[peerIndex] = nowMs }
    }

    /// Re-stamp every current player as just-seen. Called on the "everyone present"
    /// transitions (game start) so a controller that went briefly quiet isn't
    /// instantly flagged once the LOBBY gate lifts in COUNTDOWN/PLAYING.
    public func primeLiveness(_ nowMs: Double) {
        for id in players.keys { lastSeen[id] = nowMs }
    }

    /// Has this peer gone silent past the liveness window? Strict `>`: exactly-at
    /// timeout is still alive. A peer with no stamp (joined but never messaged) is
    /// always-alive here; its only cleanup path is peer_left.
    public func isExpired(_ peerIndex: Int, _ nowMs: Double) -> Bool {
        guard let seen = lastSeen[peerIndex] else { return false }
        return nowMs - seen > livenessTimeoutMs
    }

    /// Peers that just crossed the liveness window and aren't already flagged
    /// disconnected. Empty in LOBBY (a silent idle controller there is fine).
    public func expiredPeers(_ nowMs: Double) -> [Int] {
        guard state != .lobby else { return [] }
        return players.keys.filter { !disconnected.contains($0) && isExpired($0, nowMs) }.sorted()
    }

    /// Is every active participant (the `order`) currently disconnected? False when
    /// there is no active order (lobby), so an empty game never auto-pauses.
    public var allParticipantsDisconnected: Bool {
        guard !order.isEmpty else { return false }
        return !order.contains { !disconnected.contains($0) }
    }

    /// Any roster member not in the active participant order (joined after the game
    /// started). They're who the grace window waits for.
    public var hasLateJoiners: Bool {
        players.keys.contains { !order.contains($0) }
    }

    /// Deadline-driven late-joiner grace. While PLAYING with every participant gone
    /// but late joiners waiting, the first call arms a deadline at nowMs + graceMs
    /// and returns false; a later call returns true exactly once when it elapses.
    /// Any frame where the condition no longer holds clears the deadline, so a
    /// reconnect implicitly cancels the return-to-lobby.
    public func graceTick(_ nowMs: Double) -> Bool {
        if state == .playing && allParticipantsDisconnected && hasLateJoiners {
            if graceDeadline == nil { graceDeadline = nowMs + graceMs; return false }
            if nowMs >= graceDeadline! { graceDeadline = nil; return true }
            return false
        }
        graceDeadline = nil
        return false
    }

    /// Roster sorted by join order.
    public func list() -> [PlayerRecord] {
        players.values.sorted { $0.joinedAt < $1.joinedAt }
    }

    /// Lowest free color slot (0..MAX_PLAYERS-1), or -1 if the room is full.
    public func lowestFreeSlot() -> Int {
        let taken = Set(players.values.map { $0.colorSlot })
        for slot in 0..<EngineConstants.maxPlayers where !taken.contains(slot) { return slot }
        return -1
    }

    public func takenColorSlots() -> [Int] {
        players.values.map { $0.colorSlot }.sorted()
    }

    /// The effective host: platform master, else sticky slot, else oldest-joined
    /// eligible present player.
    public var host: Int? {
        let eligible: Set<Int>? = restricted ? Set(order) : nil
        if let provider = masterProvider, let m = provider(), isEligible(m, eligible) { return m }
        if isEligible(hostPeerIndex, eligible) { return hostPeerIndex }
        return oldestEligible(eligible, exclude: nil)
    }

    // MARK: - Internals

    private var restricted: Bool {
        (state == .countdown || state == .playing || state == .results) && !order.isEmpty
    }

    private func isEligible(_ idx: Int?, _ set: Set<Int>?) -> Bool {
        guard let idx, players[idx] != nil, !disconnected.contains(idx) else { return false }
        if let set { return set.contains(idx) }
        return true
    }

    private func oldestEligible(_ set: Set<Int>?, exclude: Int?) -> Int? {
        var best: Int?
        var bestJoin = Int.max
        for (idx, rec) in players {
            if idx == exclude { continue }
            guard isEligible(idx, set) else { continue }
            if rec.joinedAt < bestJoin { bestJoin = rec.joinedAt; best = idx }
        }
        return best
    }

    private func electNextHost(exclude: Int?) -> Int? {
        oldestEligible(restricted ? Set(order) : nil, exclude: exclude)
    }

    private func reconcileStickyHost() {
        // An empty room keeps the slot untouched (JS parity); nulling it here
        // would emit a spurious host change on an empty-room state transition.
        guard !players.isEmpty else { return }
        let eligible: Set<Int>? = restricted ? Set(order) : nil
        if isEligible(hostPeerIndex, eligible) { return }
        hostPeerIndex = electNextHost(exclude: hostPeerIndex)
    }

    private func snapshotOrder() {
        order = players.values
            .filter { $0.connected }
            .sorted { $0.joinedAt < $1.joinedAt }
            .map { $0.peerIndex }
    }

    /// Runs `body`, emitting `onHostChange` if the effective host changed.
    private func emittingHostChange(_ body: () -> Void) {
        let before = host
        body()
        let after = host
        if before != after { onHostChange?(after) }
    }
}
