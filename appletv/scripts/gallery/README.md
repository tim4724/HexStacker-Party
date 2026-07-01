# tvOS screen gallery

A screenshot mechanism for the tvOS app, modelled on the web `public/gallery.html`:
render every display state with fake data, capture each to a PNG, and assemble a
single page that puts the **web reference** next to the **native tvOS render** so
visual gaps are easy to spot and close.

## How it works

The app has a `HEXSHOT=<state>` render mode (see
`DisplayCoordinator.renderShot` + `RootScene`): it sets up one screen with
deterministic fake data, then stops ticking so the screen holds still for a
Simulator screenshot. States:

| state | what it shows |
| --- | --- |
| `lobby` / `lobby-empty` | lobby with players / waiting for players |
| `countdown` | fresh boards behind the 3-2-1 number |
| `game` / `game-lv8` / `game-lv12` | mid-game boards (Normal / Pillow / Neon tiers) |
| `pause` / `pause-music` | pause overlay (default focus / MUSIC switch focused) |
| `disconnected` | a board's rejoin QR overlay |
| `results` / `results-solo` | ranked results / single player |

`HEXPLAYERS=<n>` sets the player count (default 4).

## Regenerate

```bash
# 1. native tvOS shots (builds, installs to the booted Apple TV sim, captures all states)
bash appletv/scripts/gallery/capture-tvos.sh
#    reuse an existing build with: HEX_SKIP_BUILD=1
#    pick a sim with:             HEX_SIM=<udid>

# 2. web reference shots (needs the server running + Playwright)
PORT=8770 node server/index.js &                 # from the repo root
node appletv/scripts/gallery/capture-web.mjs http://localhost:8770

# 3. assemble the page
node appletv/scripts/gallery/gen-gallery.mjs
open appletv/scripts/gallery/gallery.html
```

The web step is optional — without it the page just shows the tvOS column.
Captured PNGs and `gallery.html` are git-ignored (regenerable artifacts).
