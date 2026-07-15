#!/usr/bin/env bash
# Record the tvOS transition tour (HEXTOUR) to an mp4 for motion review —
# the tvOS mirror of `npm run record:transitions` (web). Builds the app,
# launches it in tour mode on the simulator (DisplayModel.runTransitionTour
# drives every screen edge through the production triggers), records with
# `simctl io recordVideo`, and re-encodes to H.264 mp4 (the raw .mov is kept
# if ffmpeg isn't installed).
#
# Env (same knobs as scripts/gallery/capture-tvos.sh):
#   HEX_SIM          Simulator device UDID (default: Apple TV 4K 3rd gen)
#   HEX_DD           derivedData path (default: $TMPDIR/hexdd)
#   HEX_SKIP_BUILD   =1 to reuse an existing build
#   HEX_TOUR_SECONDS recording length after launch (default 50; the tour's
#                    last step fires at 43s)
#
# Output: recordings/transitions-tvos-<stamp>.mp4 (gitignored; timestamped so
# successive renders can be compared side by side).
set -euo pipefail

DEV="${HEX_SIM:-BBB6AE86-6F9B-4D20-8966-3E9CDBF38632}"
BUNDLE="com.hexstacker.tv"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
APPLETV="$ROOT/appletv"
DD="${HEX_DD:-$TMPDIR/hexdd}"
TOUR_SECONDS="${HEX_TOUR_SECONDS:-50}"
STAMP="$(date +%Y-%m-%d-%H-%M-%S)"
OUT="$ROOT/recordings/transitions-tvos-$STAMP.mp4"
mkdir -p "$ROOT/recordings"

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

# bootstatus -b boots if needed and blocks until fully booted: recordVideo
# started against a still-booting device wedges silently (it reports success
# but stops capturing frames after a few seconds).
xcrun simctl bootstatus "$DEV" -b >/dev/null
xcrun simctl install "$DEV" "$APP"
xcrun simctl terminate "$DEV" "$BUNDLE" >/dev/null 2>&1 || true
sleep 2

RAW_DIR="$(mktemp -d)"
RAW="$RAW_DIR/tour.mov"
trap 'rm -rf "$RAW_DIR"' EXIT

# Start the recorder first so the app launch + lobby entrance land on film;
# recordVideo finalizes the file on SIGINT.
xcrun simctl io "$DEV" recordVideo --codec h264 --force "$RAW" &
REC=$!
sleep 1
# Pin to English like the gallery captures, comparable across host locales.
SIMCTL_CHILD_HEXTOUR=1 \
  xcrun simctl launch "$DEV" "$BUNDLE" -AppleLanguages "(en)" -AppleLocale en_US >/dev/null
echo "recording ${TOUR_SECONDS}s tour…"
sleep "$TOUR_SECONDS"
kill -INT "$REC"
wait "$REC" 2>/dev/null || true
xcrun simctl terminate "$DEV" "$BUNDLE" >/dev/null 2>&1 || true

if ffmpeg -hide_banner -loglevel error -y -i "$RAW" \
    -c:v libx264 -pix_fmt yuv420p -crf 18 -preset medium -movflags +faststart "$OUT" 2>/dev/null; then
  echo "Recorded -> ${OUT#"$ROOT"/}"
  # A wedged recorder still exits 0 with a truncated file; catch it here.
  DUR="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT" 2>/dev/null | cut -d. -f1)"
  if [ "${DUR:-0}" -lt "$((TOUR_SECONDS - 10))" ]; then
    echo "WARNING: recording is only ${DUR:-0}s (expected ~${TOUR_SECONDS}s); recordVideo likely wedged, re-run." >&2
    exit 1
  fi
else
  KEEP="${OUT%.mp4}.mov"
  cp "$RAW" "$KEEP"
  echo "ffmpeg unavailable or failed; kept the raw recording -> ${KEEP#"$ROOT"/}"
fi
