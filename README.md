# HexStacker Party

![HexStacker Party gameplay banner](artwork/gameplay-21x9.png)

Multiplayer hex stacker where phones become controllers and a shared screen shows the action.

**Play now at [hexstacker.com](https://hexstacker.com)**

**UI gallery**: [main.hexstacker.com/gallery.html](https://main.hexstacker.com/gallery.html) — every screen, every state (design reference)

## Overview

HexStacker Party supports 1 to 8 players on a single shared display. One browser window acts as the game screen (TV, monitor, or laptop), while each player joins by scanning a QR code with their phone. The phone becomes a touch-based controller with gesture input and haptic feedback. The display client runs the authoritative game engine. Controllers send input directly to the display over WebRTC DataChannels; the relay handles WebRTC signaling, game event delivery, and input fallback.

## Architecture

```mermaid
---
title: Game events
---
graph LR
    D[Display Browser] -- "game events (WebSocket)" --> R[Party-Sockets Relay]
    R -- "game events (WebSocket)" --> P[Phone Controllers]
```

```mermaid
---
title: Controller input path
---
graph LR
    P[Phone Controllers] <-- "signaling (WebSocket)" --> R[Party-Sockets Relay]
    R <-- "signaling (WebSocket)" --> D[Display Browser]
    P -- "input fallback (WebSocket)" --> R
    R -- "input fallback (WebSocket)" --> D
    P -- "input (DataChannel)" --> D
    linkStyle 2 stroke:#94a3b8,stroke-dasharray:4,stroke-width:1px
    linkStyle 3 stroke:#94a3b8,stroke-dasharray:4,stroke-width:1px
    linkStyle 4 stroke:#22c55e,stroke-width:2px
```

The display browser runs the authoritative game engine and renders all player boards. After WebRTC negotiation via the relay, controllers send input directly to the display over a DataChannel. The relay also carries game events from the display to controllers and serves as an input fallback. The Node.js server only serves static files and a QR code API.

## Features

- 1–8 players on one screen
- QR code join – scan and play, no app install
- Touch gesture controls with haptic feedback
- Flat-top hexagonal grid with dual-zigzag line clears
- Competitive mode with garbage lines
- Rotation with wall kicks
- 8-bag randomizer (I, O, S, Z, q, p, L, J)
- Per-player start level selection (1–15) and color picker in lobby
- Controller settings overlay: audio, haptics, touch sensitivity
- Localized UI (11 languages)
- AirConsole platform support (`screen.html` / `controller.html`)

## Quick Start

```bash
npm install
node server/index.js
```

1. Open `http://localhost:4000` on a big screen.
2. Players scan the QR code with their phones to join.
3. The first player to join is the host and starts the game.
4. Use touch gestures on your phone to control pieces. Last player standing wins.

## Controller Gestures

| Gesture | Action |
|---|---|
| Drag left/right | Move piece horizontally (ratcheting at 44 px steps) |
| Tap | Rotate clockwise |
| Flick down | Hard drop |
| Drag down + hold | Soft drop (variable speed based on drag distance) |
| Flick up | Hold piece |

All gestures provide haptic feedback on supported devices. The controller uses axis locking so horizontal and vertical movements do not interfere with each other.

## Project Structure

```
server/      # Game engine modules (isomorphic UMD, used by display + tests)
public/
  display/   # Display client: game authority, Canvas renderer
  controller/# Phone touch controller
  shared/    # Protocol, relay connection, colors, theme, shared UI
scripts/     # Build and code-generation scripts (AirConsole HTML generator)
tests/       # Unit tests (node:test) and Playwright E2E
artwork/     # Banner, favicon, and cover art generators (Playwright)
```

## Configuration

The display and controllers connect to a [Party-Sockets](https://github.com/tim4724/Party-Sockets) WebSocket relay for message forwarding. The relay URL is set in `public/shared/protocol.js`. If you run your own relay, update this value and the CSP `connect-src` directive in `server/index.js`.

| Environment Variable | Default | Description |
|---|---|---|
| `PORT` | `4000` | HTTP server port |
| `BASE_URL` | Auto-detected LAN IP | Base URL for join links and QR codes |
| `APP_ENV` | `development` | Set to `production` for production mode |
| `GIT_SHA` | – | Git commit SHA shown in version endpoint |

## Testing

```bash
# Unit tests
npm test

# E2E lifecycle tests
npm run test:e2e

# AirConsole E2E tests
npm run test:e2e:airconsole

# Relay load test (k6 — requires k6 installed)
k6 run scripts/relay-loadtest.k6.js
```

Unit tests use Node.js's built-in `node:test` runner with `node:assert/strict` — no test framework dependency. E2E tests use Playwright against a live server on port 4100. UI regressions are caught via the live gallery at `/gallery.html`. The relay load test models 5-client rooms (1 display + 4 controllers) against the configured relay URL; see the script header for environment knobs.

## Tech Stack

- **Runtime**: Node.js
- **Relay**: [Party-Sockets](https://github.com/tim4724/Party-Sockets) WebSocket relay (signaling + game events)
- **P2P**: WebRTC DataChannels for low-latency controller input
- **QR codes**: [qrcode](https://github.com/soldair/node-qrcode)
- **Frontend**: Vanilla JavaScript, Canvas API
- **Testing**: Node.js built-in test runner + Playwright
- **Production deps**: 1 npm package (`qrcode`)

No build step. No bundler. No framework. Serve and play.
