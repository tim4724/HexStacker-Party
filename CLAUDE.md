# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm test                       # Unit tests (node:test)
node --test tests/hex-board.test.js  # Single unit test
npm run test:e2e               # Playwright E2E lifecycle tests
npm run test:e2e:airconsole    # Playwright E2E AirConsole tests
```

## Key Rules

- UI regressions are caught via the gallery (`public/gallery.html`), not visual snapshots
- Engine modules (`server/*.js`) use UMD — must work in both Node.js and browser
- CSP headers in `server/index.js` — update when adding external resources
- Relay URL configured in `public/shared/protocol.js`
- Controller input uses WebRTC DataChannels (`partyplug/PartyFastlane.js`) with the relay as signaling channel and input fallback; game events flow display → relay → controllers over WebSocket
- PartyPlug (`partyplug/`) is the reusable party-game framework (transport layer) shared across games, served under `/partyplug/`. Relay/STUN config lives in `public/shared/protocol.js` and is injected into the kit at construction; the kit reads no game globals
