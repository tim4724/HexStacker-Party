import Testing
import Foundation
@testable import HexStackerKit

/// Integration tests for the REAL `RelayClient` over a real loopback WebSocket
/// (`MockRelayServer`). These cover the URLSession WebSocket path the headless
/// `FakeTransport` suites can't reach: socket connect, the create/join handshake,
/// inbound frame decode + dispatch, outbound envelope shape, and auto-reconnect
/// with `clientId` re-join. No external network — the mock relay listens on
/// loopback with an ephemeral port. Runs under `swift test` on macOS.
///
/// The real client is intentionally not deterministic to the millisecond (real
/// sockets, real reconnect backoff), so assertions poll with generous deadlines.
/// Serialized: on a cold CI runner, concurrent URLSession connects to parallel
/// NWListeners have taken >10 s to open, blowing every in-flight deadline at
/// once; one live socket at a time keeps the timing assumptions honest.
@Suite(.serialized) struct RelayClientLiveTests {

    /// RelayClient delivers callbacks on `cbQueue` (a background serial queue), so
    /// a plain sleep-poll from the test thread observes the captured state without
    /// needing to pump the test thread's run loop.
    private let cbQueue = DispatchQueue(label: "relay.test.cb")

    private func waitUntil(_ timeout: TimeInterval = 5, _ cond: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if cond() { return true }
            Thread.sleep(forTimeInterval: 0.02)
        }
        return cond()
    }

    @Test func createHandshakeAndInboundDispatch() throws {
        let server = try MockRelayServer(); try server.start()
        defer { server.stop() }

        let client = RelayClient(baseURL: server.baseURL, clientId: "display", callbackQueue: cbQueue)
        defer { client.disconnect() }

        let state = Captured()
        client.onCreated = { room, inst, _ in state.set { $0.room = room; $0.instance = inst } }
        client.onPeerJoined = { idx in state.set { $0.joined.append(idx) } }
        client.onMessage = { from, data in state.set { $0.messages.append((from, data)) } }

        client.connect()

        // The socket connected, the client sent `create`, and the server's
        // `created` reply was decoded back into onCreated with the room +
        // instance. The first open on a cold CI runner has taken >10 s.
        #expect(waitUntil(15) { state.get().room != nil }, "onCreated fired")
        #expect(state.get().room == server.roomCode)
        #expect(state.get().instance == server.instance)
        #expect(waitUntil { !server.receivedEnvelopes(type: "create").isEmpty }, "server saw a create")
        #expect(server.receivedEnvelopes(type: "create").first?["clientId"] as? String == "display",
                "create carries the display clientId")
        #expect(server.receivedEnvelopes(type: "create").first?["url"] as? String == HexStackerKit.Protocol.controllerURLTemplate,
                "create registers the controller-URL template for code-only joins")

        // Inbound peer_joined + message frames are decoded and dispatched.
        server.pushPeerJoined(1)
        #expect(waitUntil { state.get().joined == [1] }, "peer_joined dispatched")
        server.pushMessage(from: 1, data: ["type": "hello", "name": "Alice"])
        #expect(waitUntil { state.get().messages.count == 1 }, "message dispatched")
        #expect(state.get().messages.first?.0 == 1, "message carries the sender index")
        #expect((state.get().messages.first?.1["name"] as? String) == "Alice", "payload decoded")

        // Outbound: sendTo wraps the payload in a `send` envelope addressed to the peer.
        client.sendTo(1, ["type": "welcome"])
        #expect(waitUntil {
            server.receivedEnvelopes(type: "send").contains {
                ($0["to"] as? Int) == 1 && (($0["data"] as? [String: Any])?["type"] as? String) == "welcome"
            }
        }, "sendTo delivered a well-formed unicast envelope")

        // Broadcast omits `to`.
        client.broadcast(["type": "game_start"])
        #expect(waitUntil {
            server.receivedEnvelopes(type: "send").contains {
                $0["to"] == nil && (($0["data"] as? [String: Any])?["type"] as? String) == "game_start"
            }
        }, "broadcast omits the recipient")
    }

    @Test func reconnectsWithJoinAfterDrop() throws {
        let server = try MockRelayServer(); try server.start()
        defer { server.stop() }
        server.peersOnJoin = [1]

        let client = RelayClient(baseURL: server.baseURL, clientId: "display", callbackQueue: cbQueue)
        defer { client.disconnect() }

        let state = Captured()
        client.onCreated = { room, _, _ in state.set { $0.room = room } }
        client.onJoined = { _, peers in state.set { $0.rejoinPeers = peers } }

        client.connect()
        #expect(waitUntil(15) { state.get().room != nil }, "initial create landed")
        #expect(server.connectionCount == 1)

        // The relay link drops. RelayClient must auto-reconnect (first backoff ~1 s)
        // and re-handshake with `join` + the pinned clientId — NOT another `create`,
        // which is what restores it to slot 0 on the relay.
        server.dropCurrentConnection()
        #expect(waitUntil(8) { server.connectionCount >= 2 }, "client reopened a socket")
        #expect(waitUntil(8) { !server.receivedEnvelopes(type: "join").isEmpty }, "reconnect sent join")
        let join = server.receivedEnvelopes(type: "join").first
        #expect(join?["clientId"] as? String == "display", "join carries the display clientId (slot-0 restore)")
        #expect(join?["room"] as? String == server.roomCode, "join re-pins the created room")
        #expect(server.receivedEnvelopes(type: "create").count == 1, "reconnect does not create a second room")
        #expect(waitUntil(3) { state.get().rejoinPeers == [1] }, "onJoined delivered the reconnect roster")
    }

    @Test func suspendClosesWithoutReconnectAndResumesWithJoin() throws {
        let server = try MockRelayServer(); try server.start()
        defer { server.stop() }

        let client = RelayClient(baseURL: server.baseURL, clientId: "display", callbackQueue: cbQueue)
        defer { client.disconnect() }

        let state = Captured()
        client.onCreated = { room, _, _ in state.set { $0.room = room } }
        client.onJoined = { _, peers in state.set { $0.rejoinPeers = peers } }

        client.connect()
        #expect(waitUntil(15) { state.get().room != nil }, "initial create landed")

        // Backgrounding suspends the socket. This is a deliberate close, so the
        // auto-reconnect that follows an ordinary drop must NOT fire.
        client.suspend()
        Thread.sleep(forTimeInterval: 1.5)   // past the first ~1 s backoff
        #expect(server.connectionCount == 1, "suspend did not auto-reconnect")

        // Foregrounding resumes with a fresh socket and a `join` that re-pins the
        // room + clientId (slot-0 restore), not a second `create`.
        client.reconnectNow()
        #expect(waitUntil(8) { server.connectionCount == 2 }, "resume opened a new socket")
        #expect(waitUntil(8) { !server.receivedEnvelopes(type: "join").isEmpty }, "resume sent join")
        let join = server.receivedEnvelopes(type: "join").first
        #expect(join?["clientId"] as? String == "display", "join carries the display clientId")
        #expect(join?["room"] as? String == server.roomCode, "join re-pins the suspended room")
        #expect(server.receivedEnvelopes(type: "create").count == 1, "resume does not create a second room")
        #expect(waitUntil(3) { state.get().rejoinPeers != nil }, "onJoined fired on resume")
    }

    @Test func evictionCloseFiresOnReplacedWithoutReconnect() throws {
        let server = try MockRelayServer(); try server.start()
        defer { server.stop() }

        let client = RelayClient(baseURL: server.baseURL, clientId: "display", callbackQueue: cbQueue)
        defer { client.disconnect() }

        let state = Captured()
        client.onCreated = { room, _, _ in state.set { $0.room = room } }
        client.onReplaced = { state.set { $0.replaced = true } }

        client.connect()
        #expect(waitUntil(15) { state.get().room != nil }, "initial create landed")

        // The relay evicts this display (another client claimed the "display"
        // clientId): the 4000 close must surface as onReplaced (regardless of
        // whether URLSession reports it via the didCloseWith delegate or the
        // pending receive's failure) and must NOT auto-rejoin, which would
        // evict the replacement right back (takeover ping-pong).
        server.closeCurrentConnection(code: 4000)
        #expect(waitUntil(5) { state.get().replaced }, "onReplaced fired on close 4000")
        // A would-be reconnect fires after ~1 s of backoff; give it room to
        // (wrongly) appear before asserting it didn't.
        Thread.sleep(forTimeInterval: 1.5)
        #expect(server.connectionCount == 1, "evicted client did not reconnect")
    }

    /// Thread-safe capture of results delivered on the async callback queue.
    private final class Captured {
        struct State {
            var room: String?
            var instance: String?
            var joined: [Int] = []
            var messages: [(Int, [String: Any])] = []
            var rejoinPeers: [Int]?
            var replaced = false
        }
        private var s = State()
        private let l = NSLock()
        func set(_ f: (inout State) -> Void) { l.lock(); f(&s); l.unlock() }
        func get() -> State { l.lock(); defer { l.unlock() }; return s }
    }
}
