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
    // The lobby's NavigationStack path: the About page and its Licenses
    // drill-in are pushed destinations (web: full-screen pages reached from
    // the ⓘ button). Model-owned rather than view-local so the gallery can
    // seed it and a match start can clear it.
    var aboutPath: [AboutRoute] = []
    // Gallery-only focus seed: the pause-music shot renders the Game Music
    // switch focused (no web equivalent; the scenario documents the TV focus).
    var focusMusicForShot = false

    /// The current host's identity color slot (web --player-color); nil when
    /// no host. Every host-tinted CTA reads this LIVE value, so a handoff
    /// recolors them via plain state propagation (web applyHostTint parity).
    var hostColorSlot: Int? { lobby?.hostColorSlot }

    /// The relay-link overlay is on screen. It outranks everything beneath it:
    /// Play/Pause and Menu decline while it is up, and the pause overlay hides
    /// under it so the two full-screen scrims don't stack.
    var connectionOverlayUp: Bool { connection == .reconnecting || connection == .closed }
}

/// A page pushed on the lobby's NavigationStack: About, its Licenses list,
/// then one license's text (by index into LicensesListView.entries).
enum AboutRoute: Hashable {
    case about, licenses
    case license(Int)
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
