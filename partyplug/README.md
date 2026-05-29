# PartyPlug

Reusable framework for "shared screen + phones as controllers" party games: one
big display plus any number of phone controllers that join by QR code. A game
*plugs into* the comms layer (the **Party Sockets** relay), hence the name.
PartyPlug gives a game its transport and its room/lobby/host lifecycle; the game
brings its own screens, input, and rules.

Vanilla JS, no build step. Every module is UMD — it works under Node (for tests)
and in the browser via a global. Serve this directory to the browser under
`/partyplug/` (add a static route in your server).

## Mental model

- **Slot 0 is the display; slots 1..N are controllers.**
- **Transport is pluggable.** Talk to the Party Sockets relay
  (`PartyConnection`) or run on AirConsole (`AirConsoleAdapter`) behind one
  interface, with an optional P2P low-latency input path (`PartyFastlane`).
- **`RoomFlow` is the brain** — who is in the room, who is host, what state we
  are in. It is headless: it emits events, your view renders.
- **The kit knows nothing about your game.** No DOM, no rendering, no colors,
  names, scores, or rounds. Those are yours.

## Modules

| Module | Role |
| --- | --- |
| `PartyConnection.js` | WebSocket client for the Party Sockets relay. Stable `clientId` bearer token for reconnect. |
| `AirConsoleAdapter.js` | Drop-in `PartyConnection` replacement that speaks the AirConsole SDK. |
| `PartyFastlane.js` | Optional P2P WebRTC DataChannel layer (low-latency input). Piggybacks on the connection for signaling, falls back to it. |
| `RoomFlow.js` | Headless room/lobby/host state machine: room state, roster, sticky-host election, presence. |

The transport modules read **no** game globals: deployment config (relay URL,
STUN server) is injected at construction, so the kit never depends on the game.

## Quick start

Connect a transport, feed it into `RoomFlow`, render from events, and drive
state transitions yourself. Your game owns the URLs and the countdown.

```js
// 1. Connect. The game owns the relay / STUN URLs (the kit just receives them).
const party = new PartyConnection(RELAY_URL + '/' + roomCode, { clientId: 'display' });
const fastlane = new PartyFastlane({ iceServers: [{ urls: STUN_URL }], /* ... */ });

// 2. The room/lobby/host brain.
const flow = new RoomFlow({ masterProvider: () => party.getMasterPeerIndex?.() });

// 3. Render off events.
flow.on('statechange', e => showScreen(SCREEN_FOR[e.to]));
flow.on('hostchange',  renderHostUI);
flow.on('rosterchange', renderRoster);

// 4. Feed the transport into the roster.
party.onProtocol = (type, msg) => {
  if (type === 'peer_joined') flow.addPlayer(msg.peerIndex, { name: msg.name });
  if (type === 'peer_left')   flow.removePlayer(msg.peerIndex);
};

// 5. Drive transitions. The countdown timer + visuals are yours.
function startGame() {
  flow.transitionTo('countdown');
  runYourCountdown(3, () => flow.transitionTo('playing'));
}
```

One Party Sockets relay can serve many games (rooms are namespaced by code), so
relay config is deployment-level, not framework-level.

## API reference

Conceptual model: slot 0 is always the display, slots 1..N are controllers. The
transport classes are interchangeable (`PartyConnection` and `AirConsoleAdapter`
share one interface).

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
paint (e.g. applying the AirConsole-profile locale). The kit carries no i18n
knowledge itself.

AirConsole-only extras:
- `getMasterPeerIndex()` — the master-controller rule; feed it to `RoomFlow.masterProvider`.
- `AirConsoleAdapter.installAirConsoleStorage(airconsole, { allowlist })` — a
  `localStorage` shim backed by AC persistent data. The allowlist of keys is
  **injected by the game** (the kit bakes in none), e.g.
  `{ allowlist: ['volume', 'difficulty'] }`.
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
new RoomFlow({ masterProvider? })
RoomFlow.STATES // { LOBBY, COUNTDOWN, PLAYING, RESULTS }
```

Roster (the `fields` object is opaque game data: color, name, score, etc.):

| Method | Purpose |
| --- | --- |
| `addPlayer(peerIndex, fields?)` | Add (or reconnect/refresh) a player; returns the live record |
| `removePlayer(peerIndex)` | Hard leave |
| `rekey(oldId, newId)` | Reconnect-claim: move a record to a new peerIndex, preserving it + host slot |
| `markDisconnected(peerIndex)` / `markReconnected(peerIndex)` | Soft blip window |
| `clearDisconnected()` | Mark everyone present (e.g. at game start) |

The game owns its per-player fields and mutates them on the live record directly
(e.g. `flow.get(id).score = 10`); RoomFlow never reads them. The only fields it
touches are `peerIndex`, `joinedAt` (host-election tiebreak), and `connected`.

Lifecycle: `transitionTo(state)` (the primary API), `endGame(results)` (sugar for
`-> RESULTS` + stash results), `returnToLobby()`, `setActiveOrder(peerIndices)`,
`reset()`. The countdown timer is the game's; the kit just exposes the
`COUNTDOWN` state. Entering `COUNTDOWN` snapshots the participant order.

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

Player record: `{ peerIndex, joinedAt, connected, ...gameFields }`.

#### How host election works

Effective host (`flow.host`) resolves as: the platform master (via
`masterProvider`, if eligible) → the sticky host slot (first joiner, if present
and connected) → the oldest-joined eligible present player. During
`COUNTDOWN`/`PLAYING`/`RESULTS` the candidate set is restricted to the
participant order (so a late joiner can't be handed host duty for actions they
can't reach). A mid-game host disconnect keeps the slot pinned (so a reconnect
reclaims it) while `flow.host` transparently falls back to a present player; the
handoff is committed when the room re-enters `LOBBY`/`RESULTS`.

To keep host eligibility in sync with a game-maintained participant list, call
`setActiveOrder(peerIndices)` whenever that list changes; otherwise entering
`COUNTDOWN` snapshots the currently-connected roster automatically.

## Design notes & intentional constraints

Read these before building a game on RoomFlow:

- **The state machine is single-session, single-phase.** It models one
  `lobby -> countdown -> playing -> results` cycle. There is no rounds/phases
  concept and no `PAUSED` state. Games that need rounds, phases, or an in-game
  timer model those above the kit; these are the first things to extend if a
  game needs them.
- **The countdown is game-owned.** The kit exposes the `COUNTDOWN` state but runs
  no timer: a game does `transitionTo('countdown')`, runs its own
  timer/visuals/controller messaging, then `transitionTo('playing')`.
- **Two integration shapes; prefer event-driven.** The recommended shape is to
  subscribe to events and read `flow.state` / `flow.host` directly, and query
  `flow.isDisconnected()` rather than keeping a parallel presence structure. A
  game retrofitting an existing codebase can instead wrap `transitionTo` and
  alias the roster Map, but new games should use the event-driven shape.
- **`flow.players` is a stable Map; `reset()` clears it in place.** If you alias
  it, that alias stays valid across `reset()`. Never reassign `flow.players`.

## Not in the kit (yet)

The networking and flow layers are the parts genuinely shared by every game in
this style, so they came first. The following are reusable in principle but are
better extracted **against a second game** than guessed at from one:

- **Lobby + join flow** (QR rendering, roster cards, name/identity picker, the
  screen shell).
- **Liveness** (heartbeat, reconnect UI, fastlane backoff policy).
- **Theming tokens + i18n engine.**
- **A view contract** (`createGameDisplay` / `createGameController` interfaces +
  a per-game manifest) that lets a game declare its inputs and rendering without
  touching the protocol.

---

*Origin: extracted from a production HexStacker party game, which remains the
reference implementation.*
