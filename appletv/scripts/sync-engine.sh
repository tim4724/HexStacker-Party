#!/usr/bin/env bash
#
# Build the canonical game engine into the destination directory the app bundles.
#
# Single source of truth: the engine modules (server/*.js) and the RoomFlow
# reducer (partyplug/RoomFlow.js) live in the web app. The tvOS app runs the EXACT
# same JS in JavaScriptCore, so it ships ONE esbuild bundle of them, built fresh
# at build time. esbuild resolves the module graph, so there is no hand-maintained
# load order here (or in EngineBridge.swift) to keep in sync.
#
# This script is invoked by the Xcode "Sync engine JS" pre-build phase; it can
# also be run by hand. The output is never committed (see ../.gitignore) so it
# cannot drift from the canonical source.
#
# Usage: sync-engine.sh <dest-dir>
set -euo pipefail

# Xcode's build-phase PATH is minimal and usually lacks node; add the usual homes
# so `npm` resolves. (A no-op when run from a normal shell.)
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# repo root is two levels up: <repo>/appletv/scripts -> <repo>
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

DEST="${1:?usage: sync-engine.sh <dest-dir>}"
# Wipe + recreate so a switch in output set (e.g. the old loose modules ->
# this single bundle) can't leave stale files behind. Critical on the
# case-insensitive macOS FS, where the old `PartyCore.js` and the new
# `partycore.js` are the same path and would otherwise alias.
rm -rf "$DEST"
mkdir -p "$DEST"

# Build the portable native core (server/core-entry.js -> dist/partycore.js: an
# iife exposing globalThis.HexCore with PartyCore + RoomFlow). On a fresh clone
# the repo-root deps are not installed yet; bootstrap them so the first Xcode
# build works without any manual setup (later builds skip this).
if [[ ! -d "$REPO_ROOT/node_modules/esbuild" ]]; then
  echo "sync-engine: node_modules missing, running 'npm ci' at the repo root (first build only)"
  ( cd "$REPO_ROOT" && npm ci )
fi
( cd "$REPO_ROOT" && npm run --silent build:core )

# Artifacts the app bundle needs at runtime:
#   dist/partycore.js : the engine, loaded into JavaScriptCore
#   dist/locale.json  : display i18n table (generated from i18n.js)
#   lunar-joyride.mp3 : game music (read via AssetLocator)
# The partycore.js.map sourcemap is intentionally NOT copied: JavaScriptCore
# never resolves the //# sourceMappingURL comment in a shipped app, so it would
# be ~150 KB of dead weight in the bundle.
# protocol.js is intentionally NOT copied: the bundle has no protocol coupling,
# and the Swift side speaks the wire protocol via its own Protocol.swift mirror.
COPY_FILES=(
  "dist/partycore.js"
  "dist/locale.json"
  "public/shared/music/lunar-joyride.mp3"
)

for f in "${COPY_FILES[@]}"; do
  src="$REPO_ROOT/$f"
  if [[ ! -f "$src" ]]; then
    echo "sync-engine: missing file: $src" >&2
    exit 1
  fi
  cp "$src" "$DEST/$(basename "$f")"
done

echo "sync-engine: built core + copied ${#COPY_FILES[@]} files -> $DEST"
