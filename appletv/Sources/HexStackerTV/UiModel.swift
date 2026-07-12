import Foundation
import HexStackerKit

/// Immutable UI state the SwiftUI chrome renders from (Android UiModel parity).
/// DisplayModel folds every chrome-relevant DisplayOutput callback into this
/// one published value; board renders and audio bypass it.
struct UiModel: Equatable {
    var screen: DisplayScreen = .lobby
    var lobby: LobbyData? = nil
    var countdown: CountdownValue? = nil
    var results: [MatchResult] = []
    var paused = false
    var muted = false
    var connection: RelayClient.ConnectionState = .idle
    // Current retry / max, shown as "Attempt N of M" while reconnecting.
    var reconnectAttempt = 0
    var reconnectMax = 0
    // Terminal slot-0 eviction (another display took the room): DISCONNECTED
    // with no reconnect affordance.
    var replaced = false
    // Link dropped or app resigning: the shown room QR may be stale, dim it.
    // Cleared only by roomReady (the relay re-confirmed the room).
    var qrPending = false
    // Lobby-local overlays (web: full-screen pages reached from the ⓘ button).
    // Model-owned rather than view-local so the gallery can seed them.
    var showAbout = false
    var showLicenses = false
    // Gallery-only focus seed: the pause-music shot renders the Game Music
    // switch focused (no web equivalent; the scenario documents the TV focus).
    var focusMusicForShot = false
    // The lobby's two-item focus menu (START / corner ⓘ), driven manually
    // from the remote's responder chain. The native engine skips the buttons
    // while the entrance stagger has them transparent and never re-seats, so
    // a live lobby ended up with no cursor at all.
    var lobbyFocus: LobbyFocus = .start

    /// The current host's identity color slot (web --player-color); nil when
    /// no host. Every host-tinted CTA reads this LIVE value, so a handoff
    /// recolors them via plain state propagation (web applyHostTint parity).
    var hostColorSlot: Int? { lobby?.hostColorSlot }

    /// The relay-link overlay is on screen. It outranks everything beneath it:
    /// the lobby's manual menu, Play/Pause and Menu all decline while it is up,
    /// and the pause overlay hides under it so the two full-screen scrims
    /// don't stack.
    var connectionOverlayUp: Bool { connection == .reconnecting || connection == .closed }
}

enum LobbyFocus {
    case start, info
}

/// Lobby scaffold data. `room` empty = the pre-room waiting lobby (blank QR,
/// no join line). `qrText` is the QR payload — identical to `joinURL` in
/// production, distinct in the gallery JOIN fixture.
struct LobbyData: Equatable {
    var room = ""
    var joinURL = ""
    var qrText = ""
    var players: [LobbySeat] = []
    var hostColorSlot: Int? = nil
}

/// One lobby seat, snapshotted from the mutable PlayerRecord so SwiftUI gets
/// value-type diffing (peerIndex keys the join-pop animation).
struct LobbySeat: Equatable {
    let peerIndex: Int
    let name: String
    let colorSlot: Int
    let level: Int
    let joinedAt: Int
}
