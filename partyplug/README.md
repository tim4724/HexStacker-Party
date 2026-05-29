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
(`lobby -> countdown -> playing -> results`), the player roster (identity, join
order, presence), sticky-host election, an optional lobby countdown, and
disconnection tracking. It emits events; the view subscribes and renders.

It touches **no** DOM, transport, or rendering, and **no** game concepts. It has
no notion of color, name, score, or level: a player record is
`{ peerIndex, joinedAt, connected, ...gameFields }` where RoomFlow owns the
first three and treats whatever the game passes to `addPlayer()` as opaque
fields it stores but never reads. The game mutates those fields on the live
record directly. The only things RoomFlow reads off a player are `joinedAt`
(host-election tiebreak) and presence. Two more deliberate decoupling choices:
the AirConsole master-controller rule is injected as a `masterProvider` callback
(not a direct `party.getMasterPeerIndex()` call), and disconnection is tracked
as a Set (not inferred from the `disconnectedQRs` DOM map).

Two integration styles are supported. Event-driven (recommended for new games),
where RoomFlow runs the countdown and the view reacts to events:

```js
const flow = new RoomFlow({ masterProvider: () => party.getMasterPeerIndex?.() });
flow.on('statechange', e => showScreen(SCREEN_FOR[e.to]));
flow.on('hostchange', renderHostUI);
flow.on('rosterchange', updatePlayerList);
party.onProtocol = (type, msg) => {
  if (type === 'peer_joined') flow.addPlayer(msg.peerIndex, { name: msg.name });
  if (type === 'peer_left')   flow.removePlayer(msg.peerIndex);
};
flow.requestStart(); // -> countdown -> playing
```

Or imperative (how HexStacker uses it), where the game keeps its own countdown
and drives the machine with `transitionTo()`, reads `flow.host` / `flow.state`,
and feeds its participant order via `setActiveOrder()`.

**Status:** wired into HexStacker's live display. `flow.players` is the roster
backing store; `getHostPeerIndex`/`setRoomState`/`hostPeerIndex`/`roomState`
delegate to the kit.

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
new AirConsoleAdapter(airconsole, {
  role: 'display' | 'controller',
  onReady?: (code, ac) => void,   // runs before 'created'/'joined' is synthesized
})
```

Same interface and callbacks as `PartyConnection` (`onError` is a no-op, the SDK
has no error event; `create` / `join` / `reconnectNow` are no-ops). Synthesizes
the relay protocol events from SDK device events.

The `onReady` hook is the kit's seam for anything a game must do before first
paint (HexStacker applies its AirConsole-profile locale there). The kit carries
no i18n knowledge itself.

AirConsole-only extras:
- `getMasterPeerIndex()` — the master-controller rule; feed it to `RoomFlow.masterProvider`.
- `AirConsoleAdapter.installAirConsoleStorage(airconsole, { allowlist })` — a
  localStorage shim backed by AC persistent data. The allowlist of keys is
  **injected by the game** (the kit bakes in none), so a second game passes its
  own keys.
- `captureEarlyReady`, `injectVersionLabel` — AC bootstrap timing helpers.

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
new RoomFlow({ countdownSeconds = 3, goMs = 600, masterProvider?, timers? })
RoomFlow.STATES // { LOBBY, COUNTDOWN, PLAYING, RESULTS }
```

Roster (the `fields` object is opaque game data: color, name, level, etc.):

| Method | Purpose |
| --- | --- |
| `addPlayer(peerIndex, fields?)` | Add (or reconnect/refresh) a player; returns the live record |
| `removePlayer(peerIndex)` | Hard leave |
| `rekey(oldId, newId)` | Reconnect-claim: move a record to a new peerIndex, preserving it + host slot |
| `markDisconnected(peerIndex)` / `markReconnected(peerIndex)` | Soft blip window |

The game owns its per-player fields and mutates them on the record directly
(e.g. `flow.get(id).startLevel = 9`); RoomFlow never reads them.

Lifecycle: `transitionTo(state)` (imperative), `requestStart()`, `playAgain()`,
`endGame(results)`, `returnToLobby()`, `cancelCountdown()`,
`setActiveOrder(peerIndices)`, `reset()`.

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

Player record: `{ peerIndex, joinedAt, connected, ...gameFields }`.

## Design notes & intentional constraints

Read these before building a second game on RoomFlow:

- **The state machine is single-session, single-phase.** It models one
  `lobby -> countdown -> playing -> results` cycle. There is no rounds/phases
  concept, no `PAUSED` state, and the countdown is only reachable via
  `requestStart()`/`playAgain()` (no free-form timer). Games that need rounds,
  phases, or an in-game timer model those above the kit for now; these are the
  first things to extend when a second game needs them.
- **`requestStart()` vs `playAgain()`** are the same call from different states
  (LOBBY vs RESULTS); both just enter COUNTDOWN. Use `transitionTo()` directly
  if you run your own countdown (HexStacker does).
- **Prefer the event-driven integration for new games.** HexStacker's display
  uses an imperative retrofit (window getters for `roomState`/`hostPeerIndex`, a
  `players = flow.players` alias, and a parallel `disconnectedQRs` map kept in
  sync with flow's presence set). Those exist to minimize churn in an existing
  codebase. A fresh game should instead subscribe to events and read `flow.state`
  / `flow.host` directly, and query `flow.isDisconnected()` rather than keep a
  second presence structure.
- **`flow.players` is a stable Map; `reset()` clears it in place.** If you alias
  it, that alias stays valid across `reset()`. Never reassign `flow.players`.

## Not yet extracted (deliberately)

The networking and flow layers are the parts genuinely shared by every game in
this style, so they went first. The following are reusable in principle but are
still entangled with HexStacker specifics. They should be split **against a
second game**, not speculatively against this one:

- **Lobby + join flow** (QR, roster, name/color picker, screen shell)
- **Liveness** (heartbeat, reconnect, fastlane backoff)
- **Theming tokens + i18n engine**
- **The game contract** (`createGameDisplay` / `createGameController` interfaces,
  per-game manifest) that lets a game declare its inputs/render without touching
  the protocol.

See the proposal in the repo history for the full phased plan.
