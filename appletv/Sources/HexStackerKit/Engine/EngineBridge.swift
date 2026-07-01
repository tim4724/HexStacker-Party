import Foundation
import JavaScriptCore

/// Runs the canonical HexStacker game engine inside JavaScriptCore and exposes a
/// typed Swift API over it. The display is the sole authoritative simulator, so
/// this drives the whole game.
///
/// The engine ships as ONE esbuild bundle, `partycore.js` (built from
/// `server/core-entry.js` by `npm run build:core`; see `scripts/build.js`). It is
/// an iife exposing the global `HexCore` with `HexCore.PartyCore` and
/// `HexCore.RoomFlow`, so there is no module load order to maintain and no
/// `window`/`require`/CommonJS shim to provide — esbuild inlined the graph
/// (`tests/core-bundle-runtime.test.js` proves it loads with none of those).
/// PartyCore is the blessed native integration surface (`server/PartyCore.d.ts`):
/// it wraps the stateful `Game`, inverts its onEvent/onGameEnd push into a drained
/// events array, and normalizes each frame's events + value-copy snapshot into a
/// serializable host-effect `commands` list. A small JS `Bridge` shim wraps
/// construction, input, and `frame()`/`JSON.stringify`-ed payloads for easy
/// decoding.
///
/// We deliberately do NOT inject a `console` shim: bare JavaScriptCore has none,
/// and the only engine call site (Game's board-tick error path) is guarded with
/// `typeof console !== 'undefined'`, so it safely no-ops (see PartyCore.d.ts
/// "LOADER CONTRACT").
public final class EngineBridge {

    public enum EngineError: Error, CustomStringConvertible {
        case contextUnavailable
        case missingScript(String)
        case evalFailed(String)
        case bridgeUnavailable
        case decode(String)

        public var description: String {
            switch self {
            case .contextUnavailable: return "Could not create JSContext"
            case .missingScript(let f): return "Missing engine script: \(f)"
            case .evalFailed(let m): return "Engine evaluation failed: \(m)"
            case .bridgeUnavailable: return "Bridge global not available after bootstrap"
            case .decode(let m): return "Failed to decode engine output: \(m)"
            }
        }
    }

    /// The single esbuild core bundle loaded into JavaScriptCore. Built from
    /// `server/core-entry.js` (-> `dist/partycore.js`) and copied into the
    /// `engine/` dir by the "Sync engine JS" pre-build phase (`sync-engine.sh`).
    public static let coreBundleFile = "partycore.js"

    /// Holds the most recent uncaught JS exception. A reference type so the
    /// JSContext exception handler can capture it before `self` is initialized.
    private final class ExceptionBox { var message: String? }

    private let context: JSContext
    private let bridge: JSValue
    private let decoder = JSONDecoder()
    private let exceptionBox: ExceptionBox

    /// Reports a JS exception raised by a fire-and-forget engine call (input,
    /// tick, pause). Without this such errors were dropped AND left in the shared
    /// exception box, where they were mis-attributed to the next frame()/snapshot().
    /// Now every call drains the box; this surfaces the ones that have no return
    /// value to throw from. Defaults to nil (no-op).
    public var onEngineError: ((String) -> Void)?

    /// - Parameter engineDirectory: a directory containing the `partycore.js`
    ///   core bundle (in production: the app bundle's `engine/` folder; in tests:
    ///   the repo's `dist/` folder, freshly built from the canonical source).
    public init(engineDirectory: URL) throws {
        guard let ctx = JSContext() else { throw EngineError.contextUnavailable }

        let box = ExceptionBox()
        ctx.exceptionHandler = { _, exc in
            box.message = exc?.toString() ?? "unknown JS exception"
        }
        func takeLocal() -> String? { defer { box.message = nil }; return box.message }

        // One self-contained bundle: no `window`/`require` shim needed (esbuild
        // inlined the module graph behind the global `HexCore`).
        let url = engineDirectory.appendingPathComponent(Self.coreBundleFile)
        guard let src = try? String(contentsOf: url, encoding: .utf8) else {
            throw EngineError.missingScript(url.path)
        }
        ctx.evaluateScript(src, withSourceURL: url)
        if let e = takeLocal() { throw EngineError.evalFailed("\(Self.coreBundleFile): \(e)") }

        ctx.evaluateScript(Self.bootstrapJS)
        if let e = takeLocal() { throw EngineError.evalFailed("bootstrap: \(e)") }

        guard let b = ctx.objectForKeyedSubscript("Bridge"), !b.isUndefined, !b.isNull else {
            throw EngineError.bridgeUnavailable
        }

        self.context = ctx
        self.bridge = b
        self.exceptionBox = box
    }

    // MARK: - Game control

    /// Construct and `init()` a new game. `players` order defines snapshot order.
    public func createGame(players: [(id: Int, startLevel: Int)], seed: UInt32) throws {
        let specs = players.map { [$0.id, $0.startLevel] }
        bridge.invokeMethod("create", withArguments: [specs, Int(seed)])
        if let e = takeException() { throw EngineError.evalFailed("create: \(e)") }
    }

    /// Discrete input. `action` must be one of: left, right, rotate_cw,
    /// hard_drop, hold. (hard_drop locks synchronously and emits events.)
    public func processInput(playerId: Int, action: String) {
        invoke("processInput", [playerId, action])
    }

    public func softDropStart(playerId: Int, speed: Int? = nil) {
        if let speed {
            invoke("softDropStart", [playerId, speed])
        } else {
            invoke("softDropStart", [playerId])
        }
    }

    public func softDropEnd(playerId: Int) {
        invoke("softDropEnd", [playerId])
    }

    /// Advance the simulation by real elapsed milliseconds. The granular path
    /// used by the frozen-game / demo capture; the live game loop uses
    /// `frame(nowMs:)` instead, which ticks, drains and normalizes in one pull.
    public func update(deltaMs: Double) {
        invoke("update", [deltaMs])
    }

    public func pause() { invoke("pause") }
    public func resume() { invoke("resume") }

    /// Cross-device mid-game rejoin: move a participant's board, garbage queue
    /// and cooldown from `oldId` to `newId` inside the engine, so the returning
    /// peer's input and snapshot land on the kept board. Mirrors the web's
    /// rekeyDisplayGamePlayer (game.boards / playerIds / garbageManager remap).
    public func rekeyPlayer(oldId: Int, newId: Int) {
        invoke("rekeyPlayer", [oldId, newId])
    }

    /// Forget the previous `frame()` timestamp so the next `frame()` re-primes
    /// with deltaMs=0 instead of a catch-up jump. The host MUST call this on
    /// leaving the active loop (pause, results), mirroring the web's
    /// `prevFrameTime = 0` reset. See PartyCore.d.ts.
    public func resetFrameClock() { invoke("resetFrameClock") }

    public var isEnded: Bool {
        invoke("isEnded")?.toBool() ?? false
    }

    // MARK: - Reading state

    public func snapshot() throws -> GameSnapshot {
        try decode(GameSnapshot.self, method: "snapshotJSON")
    }

    /// Drains and returns events accumulated since the last call.
    public func drainEvents() throws -> [GameEvent] {
        try decode([GameEvent].self, method: "drainEventsJSON")
    }

    /// Pull one engine frame via PartyCore: converts the monotonic `nowMs` into a
    /// capped delta, ticks the engine (self-gating on paused/ended), and returns
    /// this frame's `events` (complete record), a value-copy `snapshot`, and the
    /// normalized host-effect `commands`. The blessed native integration surface.
    public func frame(nowMs: Double) throws -> FrameResult {
        guard let json = bridge.invokeMethod("frameJSON", withArguments: [nowMs])?.toString(),
              let data = json.data(using: .utf8) else {
            throw EngineError.decode("frameJSON: no string returned")
        }
        if let e = takeException() { onEngineError?("frameJSON: \(e)"); throw EngineError.evalFailed("frameJSON: \(e)") }
        do { return try decoder.decode(FrameResult.self, from: data) }
        catch { throw EngineError.decode("frameJSON: \(error)") }
    }

    // MARK: - Internals

    /// Invoke a fire-and-forget engine method and DRAIN the shared exception box
    /// afterward. Draining is the point: a JS throw from input/tick/pause used to
    /// linger in the box and be mis-reported by the next frame()/snapshot(). The
    /// drained message (if any) is surfaced via onEngineError, never silently lost.
    @discardableResult
    private func invoke(_ method: String, _ args: [Any] = []) -> JSValue? {
        let result = bridge.invokeMethod(method, withArguments: args)
        if let e = takeException() { onEngineError?("\(method): \(e)") }
        return result
    }

    private func decode<T: Decodable>(_ type: T.Type, method: String) throws -> T {
        guard let json = bridge.invokeMethod(method, withArguments: [])?.toString(),
              let data = json.data(using: .utf8) else {
            throw EngineError.decode("\(method): no string returned")
        }
        if let e = takeException() { onEngineError?("\(method): \(e)"); throw EngineError.evalFailed("\(method): \(e)") }
        do { return try decoder.decode(T.self, from: data) }
        catch { throw EngineError.decode("\(method): \(error)") }
    }

    private func takeException() -> String? {
        defer { exceptionBox.message = nil }
        return exceptionBox.message
    }

    /// JS shim wrapping PartyCore (the native integration surface) in a flat,
    /// JSON-friendly API. PartyCore inverts Game's onEvent/onGameEnd push into a
    /// drained events buffer, so the shim no longer wires callbacks itself.
    private static let bootstrapJS = """
    var Bridge = (function () {
      var PartyCore = HexCore.PartyCore;
      var core = null;
      return {
        create: function (specs, seed) {
          var map = new Map();
          for (var i = 0; i < specs.length; i++) {
            map.set(specs[i][0], { startLevel: specs[i][1] });
          }
          core = new PartyCore(map, seed >>> 0);
          core.init();
        },
        processInput: function (pid, action) { if (core) core.processInput(pid, action); },
        softDropStart: function (pid, speed) {
          if (core) core.handleSoftDropStart(pid, (speed === undefined ? null : speed));
        },
        softDropEnd: function (pid) { if (core) core.handleSoftDropEnd(pid); },
        update: function (dt) { if (core) core.update(dt); },
        pause: function () { if (core) core.pause(); },
        resume: function () { if (core) core.resume(); },
        rekeyPlayer: function (oldId, newId) { if (core) core.rekeyPlayer(oldId, newId); },
        resetFrameClock: function () { if (core) core.resetFrameClock(); },
        snapshotJSON: function () { return JSON.stringify(core.snapshot()); },
        drainEventsJSON: function () { return JSON.stringify(core.drainEvents()); },
        frameJSON: function (now) { return JSON.stringify(core.frame(now)); },
        isEnded: function () { return !!(core && core.game && core.game.ended); }
      };
    })();
    """
}
