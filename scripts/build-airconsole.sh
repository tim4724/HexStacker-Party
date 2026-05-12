#!/bin/bash
# Build an AirConsole-ready ZIP package for upload to airconsole.com/developers
#
# AirConsole expects screen.html and controller.html at the root of the ZIP,
# with all assets referenced via relative paths.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$PROJECT_DIR/build/airconsole"
APP_VERSION=$(node -e "console.log(require('$PROJECT_DIR/package.json').version)")
ZIP_FILE="$PROJECT_DIR/build/hexstacker-party-airconsole-$APP_VERSION.zip"

echo "Building AirConsole package..."

# Generate AirConsole HTML from canonical index.html files
node "$SCRIPT_DIR/generate-airconsole-html.js"

# Clean previous build
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

# Copy public files (shared, display, controller assets). Favicons are
# intentionally not copied — they belong to the top-level document and the
# AC iframe can't surface them to the browser tab.
cp -r "$PROJECT_DIR/public/shared" "$BUILD_DIR/shared"
cp -r "$PROJECT_DIR/public/display" "$BUILD_DIR/display"
cp -r "$PROJECT_DIR/public/controller" "$BUILD_DIR/controller"

# Copy engine modules (from server/ to engine/ for browser access).
# Every server/*.js except index.js is assumed to be a browser-compatible
# UMD engine module and gets bundled into the AC ZIP — if a Node-only
# utility is ever added to server/, exclude it here.
mkdir -p "$BUILD_DIR/engine"
for f in "$PROJECT_DIR"/server/*.js; do
  name="$(basename "$f")"
  [ "$name" = "index.js" ] && continue
  cp "$f" "$BUILD_DIR/engine/$name"
done

# Copy AirConsole entry points to root
cp "$BUILD_DIR/display/screen.html" "$BUILD_DIR/screen.html"
cp "$BUILD_DIR/controller/controller.html" "$BUILD_DIR/controller.html"

# Bake the build version into the HTML <meta name="app-version"> tag.
# Clients read it via AirConsoleAdapter.appVersion(). Mirrors server/index.js,
# which does the same substitution at HTTP-serve time for the web flow.
# Portable sed -i (macOS requires '' suffix, Linux doesn't)
if [[ "$OSTYPE" == "darwin"* ]]; then
  sed -i '' "s/__APP_VERSION__/$APP_VERSION/g" "$BUILD_DIR/screen.html" "$BUILD_DIR/controller.html"
else
  sed -i "s/__APP_VERSION__/$APP_VERSION/g" "$BUILD_DIR/screen.html" "$BUILD_DIR/controller.html"
fi
echo "Injected version: $APP_VERSION"

# Remove standalone-only entry points and duplicate AirConsole HTML from subdirs
rm -f "$BUILD_DIR/display/index.html"
rm -f "$BUILD_DIR/controller/index.html"
rm -f "$BUILD_DIR/display/screen.html"
rm -f "$BUILD_DIR/controller/controller.html"

# Drop test harnesses (gallery / Playwright only) and legal-page assets
# (privacy.html / imprint.html aren't part of the AC zip).
rm -f "$BUILD_DIR/controller/ControllerTestHarness.js"
rm -f "$BUILD_DIR/display/DisplayTestHarness.js"
rm -f "$BUILD_DIR/shared/legal-back.js"
rm -f "$BUILD_DIR/shared/legal.css"

# Create ZIP
cd "$BUILD_DIR"
rm -f "$ZIP_FILE"
zip -r "$ZIP_FILE" . -x '*.DS_Store'

echo ""
echo "AirConsole package built: $ZIP_FILE"
echo "Upload to: https://www.airconsole.com/developers"
