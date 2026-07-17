#!/usr/bin/env bash
#
# Build the canonical engine bundle(s) from a native build phase (the Xcode
# "Sync engine JS" phase and the Android :tv Gradle build) or a test harness.
# Single source of truth for the self-bootstrapping build the app phases share:
# resolve node, install deps on a fresh clone, then run one npm build target.
#
# Usage: build-engine.sh [npm-target]   (default: build:core)
#   build:core    dist/partycore.js               — what the shipped app bundles
#   build:native  core + the conformance oracle    — what the cross-engine tests need
#
# The bundle set behind each target lives in package.json, so "what gets built"
# is defined once (this script only picks a target and guarantees the toolchain).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET="${1:-build:core}"

# GUI-launched build phases (Xcode, Android Studio, `swift test` from Xcode)
# inherit a minimal PATH that usually lacks node. Resolve it from the common
# install homes and version managers instead of assuming a fixed path, so the
# build works regardless of how the contributor installed node.
ensure_node() {
  command -v node >/dev/null 2>&1 && return 0
  local d
  for d in "$HOME/.volta/bin" "$HOME/.asdf/shims" "/opt/homebrew/bin" "/usr/local/bin"; do
    [ -x "$d/node" ] && PATH="$d:$PATH"
  done
  export PATH
  command -v node >/dev/null 2>&1 && return 0
  # nvm keeps node under a versioned dir rather than a stable bin; source it and
  # select the default alias so `node` resolves.
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    export NVM_DIR="$HOME/.nvm"
    # shellcheck source=/dev/null
    \. "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
    nvm use default >/dev/null 2>&1 || nvm use node >/dev/null 2>&1 || true
  fi
  command -v node >/dev/null 2>&1 && return 0
  echo "build-engine: could not find node. Install Node.js (https://nodejs.org) or ensure 'node' is on PATH." >&2
  return 1
}

ensure_node

cd "$REPO_ROOT"
# On a fresh clone the repo-root deps are not installed yet; bootstrap them so
# the first native build works with no manual setup (later builds skip this).
if [ ! -d node_modules/esbuild ]; then
  echo "build-engine: node_modules missing, running 'npm ci' at the repo root (first build only)"
  npm ci
fi

npm run --silent "$TARGET"
