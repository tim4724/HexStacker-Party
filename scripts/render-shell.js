'use strict';

// Single source of the app-shell placeholder expansion, shared by the build
// (scripts/prerender-html.js pre-renders every prod-served page to dist/) and
// the server (server/index.js rewrites at request time in dev, or when a prod
// build is missing). Keeping the *set* of placeholders and the substitution in one
// place means the build-rendered HTML and the server-rendered HTML can never
// disagree on which markers exist or how they expand — they differ only in the
// values each caller supplies: prod hashed-bundle tags + bare version vs dev
// individual-file tags + version-with-sha.
//
// Pure: no env, IO, clock, or globals. `subs` carries every value. A placeholder
// absent from the given HTML (e.g. a legal page that carries none, or the
// controller shell, which has no DISPLAY_* markers) simply doesn't match and
// passes through — which also makes the function idempotent on already-rendered
// HTML, the property the server relies on to serve the pre-rendered artifact
// without re-running the rewrite.
function renderShell(html, subs) {
  return html
    .replaceAll('__APP_VERSION__', subs.versionLabel)
    .replaceAll('__APP_V__', subs.appVersion)
    .replaceAll('<!--CONTROLLER_SCRIPTS-->', subs.controllerScripts)
    .replaceAll('<!--DISPLAY_SCRIPTS-->', subs.displayScripts)
    .replaceAll('<!--CONTROLLER_STYLES-->', subs.controllerStyles)
    .replaceAll('<!--DISPLAY_STYLES-->', subs.displayStyles);
}

module.exports = { renderShell: renderShell };
