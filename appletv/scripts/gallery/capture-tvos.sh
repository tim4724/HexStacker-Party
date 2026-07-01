#!/usr/bin/env bash
# Capture every tvOS display state to a PNG via the app's HEXSHOT render mode.
#
# Each state is rendered frozen with fake data (DisplayCoordinator.renderShot),
# so a Simulator screenshot captures exactly that screen. Output lands in
# scripts/gallery/shots/tvos/<state>.png.
#
# Env:
#   HEX_SIM        Simulator device UDID (default: booted Apple TV 4K 3rd gen)
#   HEX_DD         derivedData path (default: $TMPDIR/hexdd)
#   HEX_SKIP_BUILD =1 to reuse an existing build
#   HEX_PLAYERS    player count for multi-player states (default 4)
#   HEX_WAIT       seconds to let a state settle before the shot (default 3.5)
set -euo pipefail

DEV="${HEX_SIM:-BBB6AE86-6F9B-4D20-8966-3E9CDBF38632}"
BUNDLE="com.hexstacker.HexStackerTV"
APPLETV="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$APPLETV/scripts/gallery/shots/tvos"
DD="${HEX_DD:-$TMPDIR/hexdd}"
WAIT="${HEX_WAIT:-3.5}"
PLAYERS="${HEX_PLAYERS:-4}"
mkdir -p "$OUT"

# out:shot:players — out is the PNG name, shot the HEXSHOT state, players HEXPLAYERS.
SHOTS=(
  "lobby:lobby:4"
  "lobby-2p:lobby:2"
  "lobby-8p:lobby:8"
  "lobby-empty:lobby-empty:0"
  "countdown:countdown:4"
  "game:game:4"
  "game-lv8:game-lv8:4"
  "game-lv12:game-lv12:4"
  "pause:pause:4"
  "pause-music:pause-music:4"
  "disconnected-controller:disconnected-controller:4"
  "reconnecting:reconnecting:4"
  "disconnected-display:disconnected-display:4"
  "results:results:4"
  "results-solo:results-solo:1"
)

if [ "${HEX_SKIP_BUILD:-0}" != "1" ]; then
  echo "building…"
  xcodebuild -project "$APPLETV/HexStacker.xcodeproj" -scheme HexStackerTV -configuration Debug \
    -destination "platform=tvOS Simulator,id=$DEV" -derivedDataPath "$DD" build >/dev/null
fi

APP="$(find "$DD/Build/Products" -maxdepth 3 -name 'HexStackerTV.app' | head -1)"
[ -n "$APP" ] || { echo "no built .app under $DD"; exit 1; }
echo "app: $APP"

xcrun simctl boot "$DEV" 2>/dev/null || true
xcrun simctl install "$DEV" "$APP"

for entry in "${SHOTS[@]}"; do
  IFS=: read -r out shot players <<< "$entry"
  xcrun simctl terminate "$DEV" "$BUNDLE" >/dev/null 2>&1 || true
  SIMCTL_CHILD_HEXSHOT="$shot" SIMCTL_CHILD_HEXPLAYERS="$players" \
    xcrun simctl launch "$DEV" "$BUNDLE" >/dev/null
  sleep "$WAIT"
  xcrun simctl io "$DEV" screenshot "$OUT/$out.png" >/dev/null
  echo "  captured $out"
done

xcrun simctl terminate "$DEV" "$BUNDLE" >/dev/null 2>&1 || true
echo "done -> $OUT"
