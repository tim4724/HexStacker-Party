'use strict';

// Single source of the app-shell placeholder expansion. server/index.js wraps
// this in renderPage() and drives it from two paths that must produce identical
// output: the boot-time HTML_CACHE and the dev/fallback per-request rewrite. The
// callers differ only in the values they supply (prod hashed-bundle tags + the
// runtime version label vs dev individual-file tags), never in the set of
// placeholders or how they expand — that lives here.
//
// Pure: no env, IO, clock, or globals. `subs` carries every value. A placeholder
// absent from the given HTML (e.g. a legal page that carries none, or the
// controller shell, which has no DISPLAY_* markers) simply doesn't match and
// passes through — which also makes the function idempotent, kept honest by
// tests/render-shell.test.js.
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
