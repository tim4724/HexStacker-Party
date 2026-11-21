'use strict';

// Single source of the app-shell placeholder expansion. scripts/build-site.js
// renders every deployed page with it; server/index.js wraps it in renderPage()
// for local dev and e2e. The callers differ only in the values they supply
// (hashed-bundle tags vs dev individual-file tags, and the version label),
// never in the set of placeholders or how they expand — that lives here.
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
    .replaceAll('<!--AC_CONTROLLER_SCRIPTS-->', subs.acControllerScripts)
    .replaceAll('<!--AC_DISPLAY_SCRIPTS-->', subs.acDisplayScripts)
    .replaceAll('<!--CONTROLLER_STYLES-->', subs.controllerStyles)
    .replaceAll('<!--DISPLAY_STYLES-->', subs.displayStyles);
}

// The tag values for bundle mode: one hashed <script> and <link> per app, named
// by dist/web-manifest.json. The AirConsole variants sit beside the web bundles
// in their app's public/ dir and share its stylesheet.
function bundleSubs(manifest) {
  function script(app, dir) { return '<script src="/' + dir + '/' + manifest[app].js + '"></script>'; }
  function style(app) { return '<link rel="stylesheet" href="/' + app + '/' + manifest[app].css + '">'; }
  return {
    controllerScripts: script('controller', 'controller'),
    displayScripts: script('display', 'display'),
    acControllerScripts: script('controller-ac', 'controller'),
    acDisplayScripts: script('display-ac', 'display'),
    controllerStyles: style('controller'),
    displayStyles: style('display'),
  };
}

module.exports = { renderShell: renderShell, bundleSubs: bundleSubs };
