# PartyPlug

Reusable framework for "shared screen + phones as controllers" party games. A
game *plugs into* the comms layer (the **Party Sockets** relay server), hence
the name. PartyPlug sits alongside Party Sockets: the server moves bytes, the
kit gives games a transport to speak over.

This directory is intentionally outside `public/` so it is not tied to one
game's assets. It is served to the browser under `/partyplug/` (see the
`PARTYPLUG_DIR` remap in `server/index.js`).

## What's here today (v1: transport layer)

| Module | Role |
| --- | --- |
| `PartyConnection.js` | WebSocket client for the Party Sockets relay. Slot 0 = display, 1..N = controllers. Stable `clientId` bearer token for reconnect. |
| `PartyFastlane.js` | Optional P2P WebRTC DataChannel layer (low-latency input). Piggybacks on `PartyConnection` for signaling, falls back to the relay. |
| `AirConsoleAdapter.js` | Drop-in `PartyConnection` replacement that speaks the AirConsole SDK instead of the relay. |

These three are the proven, game-agnostic core: they read **no** game globals.
All deployment config (relay URL, STUN server) is injected by the game at
construction, so the kit never depends on the game.

## Headless flow (v1.1: `RoomFlow.js`)

`RoomFlow.js` is the room/lobby/host **state machine**, extracted from
`public/display/DisplayState.js`. It owns room state
(`lobby -> countdown -> playing -> results`), the player roster + color-slot
assignment, sticky-host election, the lobby countdown, and disconnection
tracking. It emits events; the view subscribes and renders.

It touches **no** DOM, transport, or rendering. Two deliberate changes make it
agnostic: the AirConsole master-controller rule is injected as a
`masterProvider` callback (not a direct `party.getMasterPeerIndex()` call), and
disconnection is tracked as a Set (not inferred from the `disconnectedQRs` DOM
map). Game-specific per-player config (e.g. `startLevel`) lives in `player.meta`.

```js
const flow = new RoomFlow({ maxPlayers: 8, masterProvider: () => party.getMasterPeerIndex?.() });
flow.on('statechange', e => showScreen(SCREEN_FOR[e.to]));
flow.on('hostchange', renderHostUI);
flow.on('rosterchange', updatePlayerList);
party.onProtocol = (type, msg) => {
  if (type === 'peer_joined') flow.addPlayer(msg.peerIndex, parseHello(msg));
  if (type === 'peer_left')   flow.removePlayer(msg.peerIndex);
};
```

**Status:** module built and unit-tested (`tests/room-flow.test.js`), but **not
yet wired into HexStacker's live display** — that is the Phase-2 proof. The
existing `DisplayState.js` logic is unchanged.

## The seam (how a game plugs in)

```js
// Game side (e.g. public/display/DisplayConnection.js) owns the config and
// passes it IN. The kit stays generic.
const party = new PartyConnection(RELAY_URL + '/' + roomCode, { clientId: 'display' });
const fastlane = new PartyFastlane({ iceServers: [{ urls: STUN_URL }], /* ... */ });
```

`RELAY_URL` / `STUN_URL` live in the game's `public/shared/protocol.js`, not
here. One Party Sockets relay can serve many games (rooms are namespaced by
code), so relay config is deployment-level, not framework-level.

## API reference

Conceptual model: slot 0 is always the display, slots 1..N are controllers. The
transport classes are interchangeable (`PartyConnection` and `AirConsoleAdapter`
share one interface). Deployment config is injected by the game, never read from
globals.

### `PartyConnection` — relay WebSocket client

```js
new PartyConnection(relayUrl, { clientId?, maxReconnectAttempts = 5 })
```

| Method | Purpose |
| --- | --- |
| `connect()` | Open the socket (auto-reconnects up to max) |
| `create(maxClients)` | Create a room (display, slot 0) |
| `join(room)` | Join a room by code (controller) |
| `sendTo(to, data)` | Send to one slot |
| `broadcast(data)` | Send to all peers |
| `reconnectNow()` / `resetReconnectCount()` | Manual reconnect control |
| `close()` | Tear down, stop reconnecting |

Callbacks (assigned as properties):

- `onOpen()`
- `onClose(attempt, maxAttempts, meta?)` where `meta` may carry `{ replaced }`
- `onError()`
- `onMessage(from, data)` for game messages
- `onProtocol(type, msg)` for relay events (`created`, `joined`, `peer_joined`, `peer_left`)

Props: `relayUrl`, `clientId`, `reconnectAttempt`.

### `AirConsoleAdapter` — drop-in `PartyConnection` over the AirConsole SDK

```js
new AirConsoleAdapter(airconsole, { role: 'display' | 'controller' })
```

Same interface and callbacks as `PartyConnection` (`onError` is a no-op, the SDK
has no error event; `create` / `join` / `reconnectNow` are no-ops). Synthesizes
the relay protocol events from SDK device events.

AirConsole-only extras: `getMasterPeerIndex()` (the master-controller rule, feed
it to `RoomFlow.masterProvider`), plus persistent-storage / app-version / locale
helpers (see the file).

### `PartyFastlane` — optional P2P DataChannel (low-latency input)

```js
new PartyFastlane({
  iceServers, selfIndex?, sendSignal,        // signaling piggybacks on the relay
  onInput, onPeerReady, onPeerClosed,
  onConnectionState, onRtt, emitIdleHeartbeat
})
```

Methods: `setSelfIndex(idx)`, `handleSignal(from, data)`, `open(peerIdx, opts)`
(async), `close(peerIdx)`, `closeAll()`, `enqueue(peerIdx, ev)` (send input),
`isOpen(peerIdx)`, `getStats(peerIdx)`, `getAllStats()`. Controllers initiate,
the display auto-accepts. 3s of silence fires `onPeerClosed`.

### `RoomFlow` — headless room/lobby/host state machine

```js
new RoomFlow({ maxPlayers = 8, countdownSeconds = 3, goMs = 600, masterProvider?, timers? })
RoomFlow.STATES // { LOBBY, COUNTDOWN, PLAYING, RESULTS }
```

Roster:

| Method | Purpose |
| --- | --- |
| `addPlayer(peerIndex, { name?, colorIndex?, meta? })` | Add or reconnect; returns the player record |
| `removePlayer(peerIndex)` | Hard leave |
| `markDisconnected(peerIndex)` / `markReconnected(peerIndex)` | Soft blip window |
| `setColor(peerIndex, colorIndex)` | Validated (range + collision); returns bool |
| `setMeta(peerIndex, patch)` | Game-specific per-player data (e.g. `startLevel`) |

Lifecycle: `requestStart()`, `playAgain()`, `endGame(results)`,
`returnToLobby()`, `cancelCountdown()`, `reset()`.

Reads: `state`, `host` (effective), `hostPeerIndex` (sticky), `isHost(peerIndex)`,
`list()`, `get(peerIndex)`, `has(peerIndex)`, `size`, `connectedCount`,
`isDisconnected(peerIndex)`, `lastResults`.

Events (`flow.on(type, fn)` returns an unsubscribe function; `'*'` receives all):

| Event | Detail |
| --- | --- |
| `statechange` | `{ from, to }` |
| `playerjoin` / `playerleave` | `{ player }` / `{ peerIndex }` |
| `playerupdate` | `{ player }` |
| `rosterchange` | `{ players }` |
| `hostchange` | `{ hostPeerIndex }` |
| `countdown` / `go` | `{ remaining }` / `{}` |

Player record: `{ peerIndex, name, colorIndex, joinedAt, connected, meta }`.

## Not yet extracted (deliberately)

The networking layer is the part that is genuinely the same for every game and
was already cleanly decoupled, so it went first. The following are reusable in
principle but are still entangled with HexStacker specifics. They should be
split **against a second game**, not speculatively against this one:

- **Wiring `RoomFlow` into the live display** (replacing `DisplayState.js`'s
  inline state machine + host logic with the kit module). Built and tested; not
  yet routed through the running app.
- **Lobby + join flow** (QR, roster, name/color picker, screen shell)
- **Liveness** (heartbeat, reconnect, fastlane backoff)
- **Theming tokens + i18n engine**
- **The game contract** (`createGameDisplay` / `createGameController` interfaces,
  per-game manifest) that lets a game declare its inputs/render without touching
  the protocol.

See the proposal in the repo history for the full phased plan.
