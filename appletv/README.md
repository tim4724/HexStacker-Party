# HexStacker for Apple TV (tvOS)

Native tvOS port of the HexStacker party game. tvOS ships no web browser and no
`WKWebView`, so the web display cannot run on Apple TV. This target rebuilds the
**display** natively while reusing everything else unchanged:

| Surface | Strategy |
| --- | --- |
| Game engine (`../server/*.js` + `../partyplug/RoomFlow.js`) | **Reused verbatim** in JavaScriptCore as a single esbuild bundle (`dist/partycore.js`), driven through the `PartyCore` facade (the native integration surface). No logic rewrite, no drift. |
| Wire protocol (`../public/shared/protocol.js`) | **Mirrored** to Swift constants (`Net/Protocol.swift`) for type-safety; the JS is not shipped to the device. |
| Phone controllers | **Unchanged** — players still join from a phone browser via QR. |
| Party-Server relay | **Unchanged** — Swift connects with `URLSessionWebSocketTask`. |
| Display rendering / audio / lobby | **Rebuilt natively** (SpriteKit + AVFoundation; a minimal SwiftUI shell hosts the SKView). |

The Swift bridge drives the engine through `PartyCore.frame(nowMs)` (see
`../server/PartyCore.d.ts`): each call ticks the engine on a capped delta and
returns this frame's raw events, a value-copy snapshot, and a normalized
host-effect `commands` list (controller sends, match end). That single-sources
the event→effect mapping the display used to hand-code, so it can't drift from
the web/server. The determinism of the JS engine driven from Swift is proven by
the unit tests (`swift test`), which is what makes "reuse the engine" safe.

## Layout

```
appletv/
  Package.swift                 SwiftPM: builds + tests HexStackerKit on macOS (no Xcode needed)
  project.yml                   XcodeGen spec for the tvOS app target
  scripts/sync-engine.sh        Builds the canonical engine (npm run build:core) into the app bundle at build time
  Sources/
    HexStackerKit/              Platform-agnostic core (macOS + tvOS)
      Engine/                   JavaScriptCore bridge over PartyCore + Codable snapshot/command model
      Net/                      Relay WebSocket client, protocol mirror, room/host FSM
    HexStackerTV/               tvOS-only app (SpriteKit renderer, SwiftUI lobby, audio, QR)
      Generated/engine/         (git-ignored) engine JS mirrored at build time
  Tests/
    HexStackerKitTests/         Runs the real engine via JSCore; asserts determinism + snapshot shape
```

## Build & test the core on macOS (works with Command Line Tools only)

The `HexStackerKit` core needs no Xcode and no tvOS SDK, just the Command Line
Tools plus Node (the engine ships as an esbuild bundle, so the test suite runs
`npm run build:core` from the repo root first — run `npm ci` there once):

```bash
cd appletv
swift build   # compiles the kit
swift test    # the full verification tier (no Xcode required)
```

`swift test` is the single verification tier and runs under Command Line Tools
(swift-testing ships with the toolchain). It rebuilds the engine bundle from the
canonical source, runs it through the JavaScriptCore bridge, and covers: engine
determinism + full game loop + coordinator/fastlane wiring
(`EngineBridgeTests`/`DisplayCoordinatorTests`), cross-engine render parity
(`ParityTests`), fastlane receiver netcode (`FastlaneTests`), room/host FSM +
geometry (`KitTests`), localization, and the real `RelayClient` over a loopback
WebSocket (`RelayClientLiveTests`).

## Build & run the tvOS app (needs full Xcode)

Requires Xcode (Mac App Store) for the tvOS SDK and Simulator:

```bash
brew install xcodegen          # one time
cd appletv
xcodegen generate              # produces HexStacker.xcodeproj from project.yml
open HexStacker.xcodeproj
# pick an Apple TV Simulator and Run
```

### Testing the full loop on your Mac

Only the display is native; controllers stay web pages. So you can test
end-to-end without extra hardware:

1. Run the app in the tvOS Simulator. It connects to the live relay.
2. Open the controller URL in a browser tab (or scan the on-screen QR with a
   phone) and join.

The Simulator is faithful for logic and connectivity; it is **not**
representative of real Apple TV GPU performance or Siri-Remote feel. Validate
those on hardware before shipping.

## Status

See `STATUS.md` for what is implemented, what is verified on macOS, and what
still needs the tvOS Simulator / real device to confirm.
