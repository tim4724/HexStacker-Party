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
# iife exposing globalThis.HexCore with PartyCore + RoomFlow). Node resolution +
# fresh-clone bootstrap live in the shared build-engine.sh (the Gradle :tv build
# uses it too), so the toolchain handling can't drift between the native phases.
"$REPO_ROOT/scripts/build-engine.sh" build:core

# Artifacts the app bundle needs at runtime:
#   dist/partycore.js : the engine, loaded into JavaScriptCore
#   lunar-joyride.mp3 : game music (read via AssetLocator)
# i18n is NOT copied here: display strings ship as Localizable.xcstrings (the
# committed mirror of public/shared/i18n.js, guarded by
# tests/i18n-appletv-parity.test.js).
# The partycore.js.map sourcemap is intentionally NOT copied: JavaScriptCore
# never resolves the //# sourceMappingURL comment in a shipped app, so it would
# be ~150 KB of dead weight in the bundle.
# protocol.js is intentionally NOT copied: the bundle has no protocol coupling,
# and the Swift side speaks the wire protocol via its own Protocol.swift mirror.
COPY_FILES=(
  "dist/partycore.js"
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
