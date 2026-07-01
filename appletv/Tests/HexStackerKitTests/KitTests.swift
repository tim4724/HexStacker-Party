import Testing
@testable import HexStackerKit

// Pure-logic tests for the kit (room/host FSM, geometry, theme, color math).
// Run under `swift test` (works with only Command Line Tools; no full Xcode).

@Suite struct RoomFlowTests {
    @Test func firstJoinerIsHostThenPromotesOnLeave() {
        let flow = RoomFlow()
        flow.addPlayer(peerIndex: 1, playerName: "A", colorSlot: 0)
        flow.addPlayer(peerIndex: 2, playerName: "B", colorSlot: 1)
        #expect(flow.host == 1)
        #expect(flow.lowestFreeSlot() == 2)
        #expect(flow.takenColorSlots() == [0, 1])
        flow.removePlayer(1)
        #expect(flow.host == 2)
    }

    @Test func transitionsAreValidated() {
        let flow = RoomFlow()
        #expect(flow.transition(to: .playing) == false)   // lobby -> playing invalid
        #expect(flow.transition(to: .countdown) == true)
        #expect(flow.transition(to: .playing) == true)
    }

    @Test func midGameHostStaysPinnedAcrossBlip() {
        let flow = RoomFlow()
        flow.addPlayer(peerIndex: 1, playerName: "A", colorSlot: 0)
        flow.addPlayer(peerIndex: 2, playerName: "B", colorSlot: 1)
        flow.transition(to: .countdown)
        flow.transition(to: .playing)
        flow.markDisconnected(1)
        #expect(flow.host == 2)            // effective host falls back
        #expect(flow.hostPeerIndex == 1)   // sticky slot stays pinned
        flow.markReconnected(1)
        #expect(flow.host == 1)            // reclaims on reconnect
    }

    // MARK: - Liveness / presence timeout + late-joiner grace

    @Test func livenessExpiresSilentPeersOutsideLobbyOnly() {
        let flow = RoomFlow(livenessTimeoutMs: 1000, graceMs: 5000)
        flow.addPlayer(peerIndex: 1, playerName: "A", colorSlot: 0)
        flow.addPlayer(peerIndex: 2, playerName: "B", colorSlot: 1)
        flow.onSeen(1, 0); flow.onSeen(2, 0)
        #expect(flow.expiredPeers(5000).isEmpty)   // LOBBY: idle is fine
        flow.transition(to: .countdown)
        #expect(flow.expiredPeers(500).isEmpty)    // within the window
        #expect(flow.expiredPeers(1500) == [1, 2]) // both silent past 1000ms
        flow.onSeen(1, 1500)
        #expect(flow.expiredPeers(2000) == [2])    // 1 stamped fresh, only 2 stale
    }

    @Test func allParticipantsDisconnectedAndLateJoinerGrace() {
        let flow = RoomFlow(livenessTimeoutMs: 1000, graceMs: 2000)
        flow.addPlayer(peerIndex: 1, playerName: "A", colorSlot: 0)
        flow.addPlayer(peerIndex: 2, playerName: "B", colorSlot: 1)
        flow.transition(to: .countdown)   // order = [1, 2]
        flow.transition(to: .playing)
        #expect(!flow.allParticipantsDisconnected)
        flow.markDisconnected(1); flow.markDisconnected(2)
        #expect(flow.allParticipantsDisconnected)
        // No late joiners: grace never fires (the game waits, paused, for a return).
        #expect(flow.graceTick(0) == false)
        #expect(flow.graceTick(99_999) == false)
        // A late joiner arrives → grace arms, then fires once after graceMs.
        flow.addPlayer(peerIndex: 3, playerName: "C", colorSlot: 2)   // not in order
        #expect(flow.hasLateJoiners)
        #expect(flow.graceTick(0) == false)       // arms deadline at 0 + 2000
        #expect(flow.graceTick(1000) == false)    // before deadline
        #expect(flow.graceTick(2000) == true)     // fires exactly once
        #expect(flow.graceTick(2000) == false)    // cleared
    }

    @Test func graceDeadlineClearedOnLeavingPlaying() {
        let flow = RoomFlow(livenessTimeoutMs: 1000, graceMs: 2000)
        flow.addPlayer(peerIndex: 1, playerName: "A", colorSlot: 0)
        flow.addPlayer(peerIndex: 2, playerName: "B", colorSlot: 1)
        flow.transition(to: .countdown); flow.transition(to: .playing)
        flow.markDisconnected(1); flow.markDisconnected(2)
        flow.addPlayer(peerIndex: 3, playerName: "C", colorSlot: 2)   // late joiner
        #expect(flow.graceTick(0) == false)        // game 1 arms deadline at 0 + 2000
        flow.transition(to: .lobby)                 // non-grace exit must clear it
        // Game 2: rebuild the same all-disconnected + late-joiner condition. With 3
        // now the only connected player, COUNTDOWN snapshots order = [3].
        flow.transition(to: .countdown); flow.transition(to: .playing)
        flow.markDisconnected(3)
        // A qualifying tick PAST the stale game-1 deadline (2000) must RE-ARM
        // (false), not fire immediately from a leftover deadline.
        #expect(flow.graceTick(3000) == false, "stale deadline cleared on lobby return")
        #expect(flow.graceTick(5000) == true, "re-armed deadline fires at the new time")
    }

    @Test func reconnectClearsGraceDeadline() {
        let flow = RoomFlow(livenessTimeoutMs: 1000, graceMs: 2000)
        flow.addPlayer(peerIndex: 1, playerName: "A", colorSlot: 0)
        flow.addPlayer(peerIndex: 2, playerName: "B", colorSlot: 1)
        flow.transition(to: .countdown); flow.transition(to: .playing)
        flow.markDisconnected(1); flow.markDisconnected(2)
        flow.addPlayer(peerIndex: 3, playerName: "C", colorSlot: 2)
        #expect(flow.graceTick(0) == false)       // armed
        flow.markReconnected(1)                    // a participant returns
        #expect(flow.graceTick(5000) == false)     // condition gone → deadline cleared, no fire
    }
}

@Suite struct GeometryTests {
    @Test func boardDimensions() {
        let g = HexGeometry(cellSize: 14)
        #expect(abs(g.boardWidth - 9 * 14) < 1e-9)
        #expect(abs(g.hexSize - 9) < 1e-9)
        #expect(abs(g.hexW - 2 * g.hexSize) < 1e-9)
        #expect(HexGeometry.unitVertices.count == 6, "a hex has six unit vertices")
    }

    @Test func columnParityStagger() {
        let g = HexGeometry(cellSize: 14)
        let c00 = g.hexCenter(col: 0, row: 0)
        let c10 = g.hexCenter(col: 1, row: 0)
        let c01 = g.hexCenter(col: 0, row: 1)
        #expect(abs(c00.x - g.hexSize) < 1e-9)                  // first center sits one hexSize in
        #expect(abs(c00.y - g.hexH * 0.5) < 1e-9)              // ...and half a hex down
        #expect(abs((c10.y - c00.y) - g.hexH * 0.5) < 1e-9)   // odd column down half a hex
        #expect(abs((c01.y - c00.y) - g.hexH) < 1e-9)          // row pitch == hexH
    }

    @Test func colorMathMatchesCanvas() {
        #expect(ColorMath.lighten(RGB(100, 100, 100), 15) == RGB(115, 115, 115))
        #expect(ColorMath.darken(RGB(100, 100, 100), 10) == RGB(90, 90, 90))
        #expect(ColorMath.neonDark(RGB(255, 255, 255)) == RGB(76, 76, 76))
        #expect(abs(ColorMath.luminance01(RGB(255, 255, 255)) - 1.0) < 1e-9, "white luminance is 1.0")
        #expect(Theme.playerColor(slot: 0) == RGB(255, 107, 107), "slot 0 is the canonical first player color")
    }

    @Test func layoutBuckets() {
        let l2 = LayoutEngine.layout(playerCount: 2, viewportW: 1920, viewportH: 1080)
        #expect(l2.gridCols == 2 && l2.gridRows == 1)
        #expect(l2.placements.count == 2)
        let l4 = LayoutEngine.layout(playerCount: 4, viewportW: 1920, viewportH: 1080)
        #expect(l4.placements.count == 4)
    }

    @Test func styleTierByLevel() {
        #expect(Theme.tier(forLevel: 1) == .normal)
        #expect(Theme.tier(forLevel: 6) == .pillow)
        #expect(Theme.tier(forLevel: 11) == .neonFlat)
    }
}
