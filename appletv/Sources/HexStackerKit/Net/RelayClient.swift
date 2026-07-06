import Foundation

/// The display's WebSocket client for the Party-Server relay. Ported from
/// partyplug/PartyConnection.js + the display-side handshake in
/// DisplayConnection.js. The native display is always relay slot 0 and the room
/// creator. v1 uses the relay for ALL traffic (no WebRTC fastlane).
///
/// Responsibilities: create/join handshake, send/broadcast envelopes, inbound
/// routing, capped-exponential reconnect with instance (shard) pinning, and the
/// 1 Hz self-heartbeat that detects a silently-dead socket.
public final class RelayClient: NSObject, RelayTransport {

    public enum ConnectionState { case idle, connecting, open, reconnecting, closed }

    // Consumer callbacks (delivered on `callbackQueue`, default .main).
    public var onCreated: ((_ room: String, _ instance: String?, _ region: String?) -> Void)?
    public var onJoined: ((_ room: String, _ peers: [Int]) -> Void)?
    public var onPeerJoined: ((_ index: Int) -> Void)?
    public var onPeerLeft: ((_ index: Int) -> Void)?
    public var onMessage: ((_ from: Int, _ data: [String: Any]) -> Void)?
    public var onRelayError: ((_ message: String) -> Void)?
    /// Relay evicted us because another client claimed "display" (close 4000).
    public var onReplaced: (() -> Void)?
    public var onConnectionState: ((ConnectionState) -> Void)?
    /// Fired when a reconnect is scheduled, carrying the 1-based attempt and the
    /// cap, so the overlay can show "Attempt N of M".
    public var onReconnecting: ((_ attempt: Int, _ max: Int) -> Void)?

    private let baseURL: String
    private let clientId: String
    private let maxClients: Int
    private let callbackQueue: DispatchQueue

    private let q = DispatchQueue(label: "com.hexstacker.relay")
    private var session: URLSession!
    private var task: URLSessionWebSocketTask?
    // URLSession retains its delegate strongly for the session's lifetime. Making
    // RelayClient the delegate directly forms a session -> client cycle that only
    // invalidateAndCancel breaks (making `deinit` unreachable). This proxy is the
    // retained delegate instead and forwards weakly, so the client deallocates
    // normally and its `deinit` tears the session down.
    private let wsDelegate = WeakWebSocketDelegate()

    private var lastRoom: String?
    private var lastInstance: String?

    private let maxReconnectAttempts = 5
    private var reconnectAttempt = 0
    private var shouldReconnect = true
    private var dropHandled = false
    private var reconnectTimer: DispatchSourceTimer?

    private var heartbeatTimer: DispatchSourceTimer?
    private var lastHeartbeatEcho: TimeInterval = 0
    private static let heartbeatDeadSeconds: TimeInterval = 6.0   // SELF_HEARTBEAT_DEAD_MS

    // The heartbeat only starts on created/joined, so a socket that completes the
    // WS upgrade but never gets a handshake answer (wedged shard) would otherwise
    // sit in .open forever with no probe armed. The web's liveness interval keeps
    // running across reconnects and re-detects this; this timer is the native
    // equivalent for the handshake window.
    private var handshakeTimer: DispatchSourceTimer?
    private static let handshakeTimeoutSeconds: TimeInterval = 6.0

    public init(baseURL: String = Protocol.relayURL,
                clientId: String = Protocol.displayClientId,
                maxClients: Int = Protocol.maxClients,
                callbackQueue: DispatchQueue = .main) {
        self.baseURL = baseURL
        self.clientId = clientId
        self.maxClients = maxClients
        self.callbackQueue = callbackQueue
        super.init()
        wsDelegate.client = self
        let delegateQueue = OperationQueue()
        delegateQueue.maxConcurrentOperationCount = 1
        self.session = URLSession(configuration: .default, delegate: wsDelegate, delegateQueue: delegateQueue)
    }

    // MARK: - Public control

    public func connect() {
        q.async { self.connectLocked() }
    }

    /// Manual reconnect from the terminal (gave-up) `.closed` state. Re-arms the
    /// full auto-retry budget — mirrors the web display's `resetReconnectCount()`
    /// before `reconnectNow()`. A plain `connect()` here would leave
    /// `reconnectAttempt` past the cap, so the next drop would fall straight back
    /// to `.closed` (one attempt instead of the 5-attempt capped-exponential
    /// budget). Only surfaced for the gave-up overlay, never after eviction.
    public func reconnectNow() {
        q.async {
            self.reconnectAttempt = 0
            self.connectLocked()
        }
    }

    /// Forget the current room and open a fresh one. Clears the pinned room so the
    /// next handshake sends `create` (not `join`), then tears the socket down and
    /// reconnects. Recovery path for a relay `error` of "Room not found"/"Room is
    /// full" on a reconnect (mirrors the web display's resetToWelcome, which
    /// closes the party and lets the fresh session create a new room).
    public func recreateRoom() {
        q.async {
            self.lastRoom = nil
            self.lastInstance = nil
            self.reconnectAttempt = 0
            self.stopHeartbeat()
            self.dropHandled = true          // suppress the drop handler for this deliberate cancel
            let old = self.task
            self.task = nil
            old?.cancel(with: .goingAway, reason: nil)
            self.connectLocked()             // lastRoom == nil → onSocketOpened sends `create`
        }
    }

    /// Stop for good (no reconnect) and invalidate the URLSession. The session's
    /// delegate is a weak-forwarding proxy (see `wsDelegate`), so the session does
    /// NOT keep RelayClient alive and `deinit` already tears the session down;
    /// this is the explicit-teardown path for stopping the socket + timers while
    /// keeping the instance (e.g. before a deliberate shutdown).
    public func disconnect() {
        q.async {
            self.shouldReconnect = false
            self.cancelReconnectTimer()
            self.cancelHandshakeTimer()
            self.stopHeartbeat()
            self.task?.cancel(with: .goingAway, reason: nil)
            self.task = nil
            self.setState(.closed)
            self.session.invalidateAndCancel()
        }
    }

    // Reachable because the session holds only the weak proxy, not RelayClient.
    deinit { session.invalidateAndCancel() }

    /// Unicast an app payload to one peer index.
    public func sendTo(_ index: Int, _ data: [String: Any]) {
        q.async { self.sendEnvelope(["type": "send", "data": data, "to": index]) }
    }

    /// Broadcast an app payload to all other peers (omit `to`).
    public func broadcast(_ data: [String: Any]) {
        q.async { self.sendEnvelope(["type": "send", "data": data]) }
    }

    // MARK: - Connection lifecycle

    private func connectLocked() {
        cancelReconnectTimer()
        cancelHandshakeTimer()
        dropHandled = false
        setState(reconnectAttempt > 0 ? .reconnecting : .connecting)

        guard let url = currentURL() else {
            shouldReconnect = false
            setState(.closed)
            emit { self.onRelayError?("invalid relay URL") }
            return
        }
        let old = task
        let newTask = session.webSocketTask(with: url)
        task = newTask
        newTask.resume()
        listen(on: newTask)

        // Old task's late callbacks are ignored (identity guard).
        old?.cancel(with: .goingAway, reason: nil)
    }

    private func currentURL() -> URL? {
        if let room = lastRoom, let instance = lastInstance {
            let r = room.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? room
            let i = instance.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? instance
            return URL(string: "\(baseURL)/\(r)?instance=\(i)") ?? URL(string: baseURL)
        }
        return URL(string: baseURL)
    }

    private func listen(on task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            guard let self else { return }
            self.q.async {
                guard task === self.task else { return }   // stale socket
                switch result {
                case .failure:
                    // A server-initiated close surfaces here as a receive failure,
                    // racing the didCloseWith delegate (which the identity guard
                    // ignores once `task` is cleared). Read the close code off the
                    // task itself so an eviction (4000) isn't consumed as an
                    // ordinary drop, which would auto-rejoin and start the
                    // takeover war onReplaced exists to prevent.
                    let code = task.closeCode
                    self.handleDrop(closeCode: code == .invalid ? nil : code.rawValue)
                case .success(let message):
                    switch message {
                    case .string(let s): self.handleFrame(s)
                    case .data(let d):
                        if let s = String(data: d, encoding: .utf8) { self.handleFrame(s) }
                    @unknown default: break
                    }
                    self.listen(on: task)   // re-arm
                }
            }
        }
    }

    private func handleDrop(closeCode: Int?) {
        if dropHandled { return }
        dropHandled = true
        stopHeartbeat()
        cancelHandshakeTimer()
        task = nil

        if closeCode == 4000 {
            shouldReconnect = false
            setState(.closed)
            emit { self.onReplaced?() }
            return
        }

        reconnectAttempt += 1
        if shouldReconnect && reconnectAttempt <= maxReconnectAttempts {
            // Backoff: 1s, 1.5s, 2.25s, 3.375s, capped 5s.
            let delay = min(1.0 * pow(1.5, Double(reconnectAttempt - 1)), 5.0)
            // Emit the attempt count BEFORE the state change so the overlay paints
            // "Attempt N of M" straight away — callbacks run in order on .main, so
            // showConnectionOverlay reads the count instead of flashing "connection
            // lost" first (the counter starts visibly at 1, not 2).
            let attempt = reconnectAttempt, max = maxReconnectAttempts
            emit { self.onReconnecting?(attempt, max) }
            setState(.reconnecting)
            scheduleReconnect(after: delay)
        } else {
            setState(.closed)
        }
    }

    private func scheduleReconnect(after seconds: TimeInterval) {
        cancelReconnectTimer()
        let timer = DispatchSource.makeTimerSource(queue: q)
        timer.schedule(deadline: .now() + seconds)
        timer.setEventHandler { [weak self] in self?.connectLocked() }
        timer.resume()
        reconnectTimer = timer
    }

    private func cancelReconnectTimer() {
        reconnectTimer?.cancel()
        reconnectTimer = nil
    }

    /// Force an immediate reconnect (used when the heartbeat goes silent).
    private func forceReconnect() {
        guard shouldReconnect else { return }
        stopHeartbeat()
        dropHandled = true
        let old = task
        task = nil
        old?.cancel(with: .goingAway, reason: nil)
        // A silently-dead socket is a drop: bump the attempt so connectLocked emits
        // `.reconnecting` (not `.connecting`) and surface the attempt UI. The
        // display only freezes the sim + shows the overlay on .reconnecting/.closed,
        // so emitting `.connecting` here would let the game run blind (gravity +
        // liveness sweeps) for the whole reconnect window. Mirrors the web
        // self-heartbeat, which pauses the instant the socket is declared dead.
        // `created`/`joined` resets the counter to 0 on a successful reconnect.
        reconnectAttempt += 1
        let attempt = reconnectAttempt, max = maxReconnectAttempts
        emit { self.onReconnecting?(attempt, max) }
        connectLocked()
    }

    // MARK: - Inbound frames

    private func handleFrame(_ text: String) {
        guard let data = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = obj["type"] as? String else { return }

        switch type {
        case "message":
            // Drop frames with no parseable sender rather than forwarding a -1
            // sentinel into the coordinator's per-peer handling.
            guard let from = Self.intValue(obj["from"]) else { return }
            let payload = obj["data"] as? [String: Any] ?? [:]
            // Intercept the self-heartbeat echo (slot 0) for liveness/RTT.
            if from == 0, (payload["type"] as? String) == MSG.heartbeat {
                lastHeartbeatEcho = Date().timeIntervalSince1970
                return
            }
            emit { self.onMessage?(from, payload) }

        case "created":
            let room = obj["room"] as? String ?? ""
            let instance = obj["instance"] as? String
            let region = obj["region"] as? String
            lastRoom = room
            lastInstance = instance
            reconnectAttempt = 0
            cancelHandshakeTimer()
            startHeartbeat()
            emit { self.onCreated?(room, instance, region) }

        case "joined":
            let room = obj["room"] as? String ?? lastRoom ?? ""
            let peers = (obj["peers"] as? [Any])?.compactMap { Self.intValue($0) } ?? []
            lastRoom = room
            reconnectAttempt = 0
            cancelHandshakeTimer()
            startHeartbeat()
            emit { self.onJoined?(room, peers) }

        case "peer_joined":
            if let idx = Self.intValue(obj["index"]) { emit { self.onPeerJoined?(idx) } }

        case "peer_left":
            if let idx = Self.intValue(obj["index"]) { emit { self.onPeerLeft?(idx) } }

        case "error":
            let message = obj["message"] as? String ?? "unknown relay error"
            emit { self.onRelayError?(message) }

        default:
            break   // e.g. AirConsole-only frames; ignored on the WS port
        }
    }

    // MARK: - Outbound

    private func onSocketOpened() {
        // Reconnect path sends join (clientId restores slot 0); first send creates.
        // The create registers the controller-URL template so clients holding
        // only the room code can resolve the controller page from the relay.
        if let room = lastRoom {
            sendEnvelope(["type": "join", "clientId": clientId, "room": room])
        } else {
            sendEnvelope(["type": "create", "clientId": clientId, "maxClients": maxClients,
                          "url": Protocol.controllerURLTemplate])
        }
        startHandshakeTimeout()
        setState(.open)
    }

    /// Arm the created/joined answer deadline; a silent relay is treated as a
    /// drop so the capped backoff (and eventually the gave-up overlay) applies.
    private func startHandshakeTimeout() {
        cancelHandshakeTimer()
        let timer = DispatchSource.makeTimerSource(queue: q)
        timer.schedule(deadline: .now() + Self.handshakeTimeoutSeconds)
        timer.setEventHandler { [weak self] in
            guard let self, let old = self.task else { return }
            self.task = nil
            old.cancel(with: .goingAway, reason: nil)
            self.handleDrop(closeCode: nil)
        }
        timer.resume()
        handshakeTimer = timer
    }

    private func cancelHandshakeTimer() {
        handshakeTimer?.cancel()
        handshakeTimer = nil
    }

    private func sendEnvelope(_ dict: [String: Any]) {
        guard let task,
              let data = try? JSONSerialization.data(withJSONObject: dict),
              let text = String(data: data, encoding: .utf8) else { return }
        task.send(.string(text)) { _ in /* failures surface via the receive loop */ }
    }

    // MARK: - Heartbeat

    private func startHeartbeat() {
        stopHeartbeat()
        lastHeartbeatEcho = Date().timeIntervalSince1970
        let timer = DispatchSource.makeTimerSource(queue: q)
        timer.schedule(deadline: .now() + 1, repeating: 1)
        timer.setEventHandler { [weak self] in self?.heartbeatTick() }
        timer.resume()
        heartbeatTimer = timer
    }

    private func stopHeartbeat() {
        heartbeatTimer?.cancel()
        heartbeatTimer = nil
    }

    private func heartbeatTick() {
        let now = Date().timeIntervalSince1970
        if now - lastHeartbeatEcho > Self.heartbeatDeadSeconds {
            forceReconnect()
            return
        }
        sendEnvelope(["type": "send", "data": ["type": MSG.heartbeat], "to": 0])
    }

    // MARK: - Helpers

    private func setState(_ s: ConnectionState) {
        emit { self.onConnectionState?(s) }
    }

    private func emit(_ block: @escaping () -> Void) {
        callbackQueue.async(execute: block)
    }

    private static func intValue(_ v: Any?) -> Int? {
        if let n = v as? Int { return n }
        if let n = v as? NSNumber { return n.intValue }   // JSON numbers land here; .intValue never traps
        if let d = v as? Double { return (d.isFinite && abs(d) < 9.0e15) ? Int(d) : nil }
        if let s = v as? String { return Int(s) }
        return nil
    }
}

// MARK: - WebSocket delegate (forwarded weakly, see `wsDelegate`)

extension RelayClient {
    fileprivate func socketDidOpen(_ webSocketTask: URLSessionWebSocketTask) {
        q.async {
            guard webSocketTask === self.task else { return }
            self.onSocketOpened()
        }
    }

    fileprivate func socketDidClose(_ webSocketTask: URLSessionWebSocketTask, closeCode: Int) {
        q.async {
            guard webSocketTask === self.task else { return }
            self.handleDrop(closeCode: closeCode)
        }
    }
}

/// The session's strongly-retained delegate; holds the client weakly so the
/// session never keeps RelayClient alive (see `RelayClient.wsDelegate`).
private final class WeakWebSocketDelegate: NSObject, URLSessionWebSocketDelegate {
    weak var client: RelayClient?

    func urlSession(_ session: URLSession,
                    webSocketTask: URLSessionWebSocketTask,
                    didOpenWithProtocol protocol: String?) {
        client?.socketDidOpen(webSocketTask)
    }

    func urlSession(_ session: URLSession,
                    webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
                    reason: Data?) {
        client?.socketDidClose(webSocketTask, closeCode: closeCode.rawValue)
    }
}
