# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm test                       # Unit tests (node:test)
node --test tests/hex-board.test.js  # Single unit test
npm run build                  # esbuild: web app bundles + dist/partycore.js (native core)
npm run test:e2e               # Playwright E2E lifecycle tests (runs against the prod bundle)
npm run test:e2e:airconsole    # Playwright E2E AirConsole tests
```

## Key Rules

- UI regressions are caught via the gallery (`public/gallery.html` live web review; `scripts/gallery/` cross-platform web/tvOS/Android comparison, deployed at `<preview-host>/tv-gallery/`), not visual snapshots. Gallery fixture data is single-sourced in `server/GalleryFixtures.js` (scenario map: `scripts/gallery/scenarios.json`)
- Engine modules (`server/*.js`) use UMD — must work in both Node.js and browser
- Browser script load order is single-sourced in `scripts/asset-manifest.js`; the app `index.html` files carry `<!--CONTROLLER_SCRIPTS-->` / `<!--DISPLAY_SCRIPTS-->` placeholders. Add/remove/reorder a browser script there, NOT in the HTML
- Web bundling (`scripts/build.js`, esbuild): prod (or `SERVE_BUNDLES=1`) serves one content-hashed, immutably-cached bundle per app; dev serves the individual files for instant edits. Because the bundle concatenates files into one script, mind cross-file load order: a top-level `typeof fn === 'function'` guard on a function declared in a LATER file flips to true (declarations hoist across the whole script) and can run before that file's top-level initializers — order so dependencies' initializers run first. e2e runs against the bundle via `SERVE_BUNDLES=1`
- Portable native core: `server/PartyCore.js` + the engine + `server/GalleryFixtures.js` + `partyplug/RoomFlow.js` build to `dist/partycore.js` (iife `HexCore`) for tvOS/Android TV. Keep it pure (no DOM/timers/clock/IO) — gated by `tests/portable-purity.test.js` (static) and `tests/core-bundle-runtime.test.js` (runtime, bare VM)
- CSP headers in `server/index.js` — update when adding external resources
- Relay URL configured in `public/shared/protocol.js`
- Controller input uses WebRTC DataChannels (`partyplug/PartyFastlane.js`) with the relay as signaling channel and input fallback; game events flow display → relay → controllers over WebSocket
- PartyPlug (`partyplug/`) is the reusable party-game framework (transport layer) shared across games, served under `/partyplug/`. Relay/STUN config lives in `public/shared/protocol.js` and is injected into the kit at construction; the kit reads no game globals
