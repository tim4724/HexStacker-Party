#!/usr/bin/env bash
# Capture every tvOS display state to a PNG via the app's HEXSHOT render mode.
#
# Each state is rendered frozen with fake data (DisplayCoordinator.renderShot),
# so a Simulator screenshot captures exactly that screen. The state list comes
# from scenarios.json (the cross-platform gallery manifest); output lands in
# scripts/gallery/shots/tvos/<key>.png.
#
# Env:
#   HEX_SIM        Simulator device UDID (default: booted Apple TV 4K 3rd gen)
#   HEX_DD         derivedData path (default: $TMPDIR/hexdd)
#   HEX_SKIP_BUILD =1 to reuse an existing build
#   HEX_WAIT       seconds to let a state settle before the shot (default 3.5)
set -euo pipefail

DEV="${HEX_SIM:-BBB6AE86-6F9B-4D20-8966-3E9CDBF38632}"
BUNDLE="com.hexstacker.tv"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
APPLETV="$ROOT/appletv"
OUT="$HERE/shots/tvos"
DD="${HEX_DD:-$TMPDIR/hexdd}"
WAIT="${HEX_WAIT:-3.5}"
mkdir -p "$OUT"

# key:shot:players lines from the manifest — key is the PNG name, shot the
# HEXSHOT state, players HEXPLAYERS.
SHOTS=()
while IFS= read -r line; do SHOTS+=("$line"); done < <(node -e '
  const { scenarios } = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  for (const s of scenarios) if (s.tvos) console.log(`${s.key}:${s.tvos.shot}:${s.tvos.players}`);
' "$HERE/scenarios.json")

if [ "${HEX_SKIP_BUILD:-0}" != "1" ]; then
  echo "building…"
  xcodebuild -project "$APPLETV/HexStacker.xcodeproj" -scheme HexStackerTV -configuration Debug \
    -destination "platform=tvOS Simulator,id=$DEV" -derivedDataPath "$DD" build >/dev/null
fi

# -print -quit instead of `| head -1`: head closing the pipe early would
# SIGPIPE find under pipefail if there were ever multiple matches.
APP="$(find "$DD/Build/Products" -maxdepth 3 -name 'HexStackerTV.app' -print -quit)"
[ -n "$APP" ] || { echo "no built .app under $DD"; exit 1; }
echo "app: $APP"

xcrun simctl boot "$DEV" 2>/dev/null || true
xcrun simctl install "$DEV" "$APP"

for entry in "${SHOTS[@]}"; do
  IFS=: read -r out shot players <<< "$entry"
  xcrun simctl terminate "$DEV" "$BUNDLE" >/dev/null 2>&1 || true
  # Pin the app to English so the column is comparable with the web reference
  # (captured with lang=en) and with CI shots regardless of the host Mac's locale.
  SIMCTL_CHILD_HEXSHOT="$shot" SIMCTL_CHILD_HEXPLAYERS="$players" \
    xcrun simctl launch "$DEV" "$BUNDLE" -AppleLanguages "(en)" -AppleLocale en_US >/dev/null
  sleep "$WAIT"
  xcrun simctl io "$DEV" screenshot "$OUT/$out.png" >/dev/null
  echo "  captured $out"
done

xcrun simctl terminate "$DEV" "$BUNDLE" >/dev/null 2>&1 || true
echo "done -> $OUT"
