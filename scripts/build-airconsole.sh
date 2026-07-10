#!/bin/bash
# Build an AirConsole-ready ZIP package for upload to airconsole.com/developers
#
# AirConsole expects screen.html and controller.html at the root of the ZIP,
# with all assets referenced via relative paths.
#
# All JS ships as ONE content-hashed esbuild bundle per app (the AC variants
# from scripts/build.js — web load order minus AC-dead modules, plus the AC
# bootstrap), and the CSS as the same bundles the web serves. One tag per app
# means a load is atomic: a flaky fetch on the AC CDN can no longer half-load
# the app and cascade into ReferenceErrors (uploads up to 4.4.4 shipped ~25
# individual <script> tags and did exactly that). The bundles are already
# minified and es2017-lowered, so the old per-file transpile step is gone too.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$PROJECT_DIR/build/airconsole"
APP_VERSION=$(node -e "console.log(require('$PROJECT_DIR/package.json').version)")
ZIP_FILE="$PROJECT_DIR/build/hexstacker-party-airconsole-$APP_VERSION.zip"

echo "Building AirConsole package..."

# Fresh bundles (incl. the AC variants + dist/web-manifest.json) and the AC
# HTML entry points with their script/style markers.
node "$SCRIPT_DIR/build.js"
node "$SCRIPT_DIR/generate-airconsole-html.js"

# Clean previous build
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

# Copy public asset trees (shared, display, controller). Favicons are
# intentionally not copied — they belong to the top-level document and the
# AC iframe can't surface them to the browser tab.
cp -r "$PROJECT_DIR/public/shared" "$BUILD_DIR/shared"
cp -r "$PROJECT_DIR/public/display" "$BUILD_DIR/display"
cp -r "$PROJECT_DIR/public/controller" "$BUILD_DIR/controller"

# Drop everything the bundles replace: all source JS, plus the web bundle
# artifacts / sourcemaps / precompressed siblings the tree copy picked up.
find "$BUILD_DIR" -type f \( -name '*.js' -o -name '*.js.map' -o -name '*.br' -o -name '*.gz' \) -delete
# Same for the bundled stylesheets and the web-only legal css. The @font-face
# sheets (shared/fonts/*.css) stay: they're linked directly and carry relative
# url() references to their woff2 siblings.
rm -f "$BUILD_DIR/shared/theme.css" "$BUILD_DIR/shared/results.css" \
      "$BUILD_DIR/shared/device-choice.css" "$BUILD_DIR/shared/legal.css" \
      "$BUILD_DIR/controller/controller.css" "$BUILD_DIR/display/display.css"

# Copy the content-hashed bundles this build produced (names from the build
# manifest). JS: the AC variants; CSS: the same bundles the web serves.
CTRL_JS=$(node -p "require('$PROJECT_DIR/dist/web-manifest.json')['controller-ac'].js")
DISP_JS=$(node -p "require('$PROJECT_DIR/dist/web-manifest.json')['display-ac'].js")
CTRL_CSS=$(node -p "require('$PROJECT_DIR/dist/web-manifest.json').controller.css")
DISP_CSS=$(node -p "require('$PROJECT_DIR/dist/web-manifest.json').display.css")
cp "$PROJECT_DIR/public/controller/$CTRL_JS" "$BUILD_DIR/controller/"
cp "$PROJECT_DIR/public/display/$DISP_JS" "$BUILD_DIR/display/"
cp "$PROJECT_DIR/public/controller/$CTRL_CSS" "$BUILD_DIR/controller/"
cp "$PROJECT_DIR/public/display/$DISP_CSS" "$BUILD_DIR/display/"

# AirConsole entry points at the zip root: expand the AC markers to relative
# bundle tags and bake the version (replaces the old sed pass).
node "$SCRIPT_DIR/finalize-airconsole-html.js" "$BUILD_DIR"

# Remove standalone-only entry points and the duplicate AC HTML from subdirs
rm -f "$BUILD_DIR/display/index.html"
rm -f "$BUILD_DIR/controller/index.html"
rm -f "$BUILD_DIR/display/screen.html"
rm -f "$BUILD_DIR/controller/controller.html"

# Create ZIP
cd "$BUILD_DIR"
rm -f "$ZIP_FILE"
zip -r "$ZIP_FILE" . -x '*.DS_Store'

echo ""
echo "AirConsole package built: $ZIP_FILE"
echo "Upload to: https://www.airconsole.com/developers"
