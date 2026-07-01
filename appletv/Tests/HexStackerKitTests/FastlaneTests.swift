import Testing
import Foundation
@testable import HexStackerKit

// Receiver-side fastlane netcode tests, mirroring the receiver cases in
// partyplug/tests/party-fastlane.test.js. Run under `swift test` (works with only
// Command Line Tools; no full Xcode).

private final class ManualScheduler: FastlaneScheduler {
    final class Token: FastlaneTimerToken {
        var work: (() -> Void)?
        var canceled = false
        func cancel() { canceled = true; work = nil }
    }
    var pending: [Token] = []
    func schedule(afterMs: Double, _ work: @escaping () -> Void) -> FastlaneTimerToken {
        let t = Token(); t.work = work; pending.append(t); return t
    }
    func fireAll() {
        let live = pending.filter { !$0.canceled }
        pending.removeAll()
        for t in live { t.work?() }
    }
}

private final class Harness {
    let net: FastlaneNetcode
    let scheduler = ManualScheduler()
    var sent: [(to: Int, packet: [String: Any])] = []
    var input: [(from: Int, ev: [String: Any])] = []
    var ready: [Int] = []
    var closed: [Int] = []
    var transportClosed: [Int] = []

    init() {
        net = FastlaneNetcode(now: { 0 }, scheduler: scheduler)
        net.send = { [weak self] idx, data in
            let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
            self?.sent.append((idx, obj))
        }
        net.closeTransport = { [weak self] idx in self?.transportClosed.append(idx) }
        net.onInput = { [weak self] idx, ev in self?.input.append((idx, ev)) }
        net.onPeerReady = { [weak self] idx in self?.ready.append(idx) }
        net.onPeerClosed = { [weak self] idx in self?.closed.append(idx) }
    }

    func recv(_ peerIdx: Int, _ packet: [String: Any]) {
        let data = try! JSONSerialization.data(withJSONObject: packet)
        net.peerReceived(peerIdx, data)
    }
}

@Suite struct FastlaneNetcodeTests {

    @Test func channelOpenSignalsReadyAndOpen() {
        let h = Harness()
        h.net.peerChannelOpened(1)
        #expect(h.ready == [1])
        #expect(h.net.isOpen(1))
        #expect(!h.net.isOpen(2))
    }

    @Test func appliesNewEventsAscendingAndAdvancesSeq() {
        let h = Harness()
        h.net.peerChannelOpened(1)
        h.recv(1, ["ps": 3, "t": 0, "h": [["a": 3], ["a": 2], ["a": 1]]])
        #expect(h.input.map { $0.ev["a"] as? Int } == [1, 2, 3])
        #expect(h.net.peerState(1)?.lastAppliedEs == 3)
    }

    @Test func dedupesResends() {
        let h = Harness()
        h.net.peerChannelOpened(1)
        h.recv(1, ["ps": 3, "t": 0, "h": [["a": 3], ["a": 2], ["a": 1]]])
        h.recv(1, ["ps": 3, "t": 0, "h": [["a": 3], ["a": 2], ["a": 1]]])
        #expect(h.input.count == 3)
        #expect(h.net.peerState(1)?.lastAppliedEs == 3)
    }

    @Test func mixedPacketAppliesOnlyNewTail() {
        let h = Harness()
        h.net.peerChannelOpened(1)
        h.recv(1, ["ps": 2, "t": 0, "h": [["a": 2], ["a": 1]]])
        h.recv(1, ["ps": 4, "t": 0, "h": [["a": 4], ["a": 3], ["a": 2]]])
        #expect(h.input.map { $0.ev["a"] as? Int } == [1, 2, 3, 4])
        #expect(h.net.peerState(1)?.lastAppliedEs == 4)
    }

    @Test func ignoresMalformedPsWithoutAcking() {
        let h = Harness()
        h.net.peerChannelOpened(1)
        h.recv(1, ["ps": "bogus", "t": 0, "h": [["a": 1]]])
        h.recv(1, ["t": 0, "h": [["a": 1]]])
        #expect(h.input.isEmpty)
        #expect(h.net.peerState(1)?.lastAppliedEs == 0)
        #expect(h.sent.isEmpty)
    }

    @Test func acksEveryDataPacketAndHeartbeat() {
        let h = Harness()
        h.net.peerChannelOpened(1)
        h.recv(1, ["ps": 2, "t": 100, "h": [["a": 2], ["a": 1]]])
        #expect(h.sent.count == 1)
        #expect(h.sent[0].packet["pa"] as? Int == 2)
        #expect(h.sent[0].packet["t"] as? Double == 100, "ack echoes t for RTT")
        h.recv(1, ["ps": 2, "t": 200, "h": [[String: Any]]()])   // heartbeat (h: []) is acked too
        #expect(h.sent.count == 2)
        #expect(h.sent[1].packet["pa"] as? Int == 2)
        #expect(h.sent[1].packet["t"] as? Double == 200, "heartbeat ack echoes the new t")
    }

    @Test func statsTrackOutReceivedAndMaxPs() {
        let h = Harness()
        h.net.peerChannelOpened(1)
        h.recv(1, ["ps": 5, "t": 0, "h": [["a": 5]]])
        h.recv(1, ["ps": 4, "t": 0, "h": [["a": 4]]])
        let s = h.net.getStats(1)
        #expect(s?.received == 2)
        #expect(s?.out == 2)
        #expect(s?.lastPsSeen == 5)
        #expect(h.net.getStats(99) == nil)
        // getAllStats aggregates the per-peer getStats (mirrors PartyFastlane.getAllStats).
        #expect(h.net.getAllStats()[1]?.out == 2)
    }

    @Test func watchdogTearsDownOnceOnSilence() {
        let h = Harness()
        h.net.peerChannelOpened(1)
        h.scheduler.fireAll()
        #expect(h.transportClosed == [1])
        #expect(h.closed == [1])
        #expect(!h.net.isOpen(1))
        h.net.peerChannelClosed(1)   // late transport callback
        #expect(h.closed == [1])     // not double-fired
    }

    @Test func inboundResetsWatchdog() {
        let h = Harness()
        h.net.peerChannelOpened(1)
        let openTimer = h.scheduler.pending[0]
        h.recv(1, ["ps": 1, "t": 0, "h": [["a": 1]]])
        #expect(h.net.isOpen(1))
        #expect(openTimer.canceled, "the previous watchdog timer is canceled")
        #expect(h.scheduler.pending.contains { !$0.canceled }, "a fresh watchdog is armed")
    }

    @Test func explicitCloseTearsDown() {
        let h = Harness()
        h.net.peerChannelOpened(1)
        h.net.peerChannelOpened(2)
        h.net.closePeer(1)
        #expect(h.transportClosed == [1])
        #expect(h.closed == [1])
        #expect(h.net.isOpen(2))
        h.net.closeAll()
        #expect(Set(h.closed) == [1, 2])
        #expect(!h.net.isOpen(2), "no peers open after closeAll")
    }

    @Test func detectsSignalEnvelopes() {
        #expect(FastlaneConfig.isSignalEnvelope(["__rtc": "offer", "sdp": [:]]))
        #expect(FastlaneConfig.isSignalEnvelope(["__rtc": "ice", "candidate": [:]]))
        #expect(!FastlaneConfig.isSignalEnvelope(["type": "input"]))
        #expect(!FastlaneConfig.isSignalEnvelope(nil))
        #expect(!FastlaneConfig.isSignalEnvelope("plain string"))
    }
}
