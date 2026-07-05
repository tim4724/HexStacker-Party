'use strict';

// renderShell is the single source of the app-shell placeholder expansion,
// consumed by BOTH the build (pre-rendering dist/<app>.html) and the server
// (runtime rewrite in dev / no-build fallback). These pin the properties each
// relies on: full expansion, repeat handling, and — critically — that it's a
// no-op pass-through / idempotent, which is what lets the server serve the
// build's pre-rendered output without a second rewrite ever changing the bytes.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderShell } = require('../scripts/render-shell.js');

const SUBS = {
  versionLabel: '4.2.0 (#abc1234)',
  appVersion: '4.2.0',
  controllerScripts: '<script src="/controller/controller.abc1234567.js"></script>',
  displayScripts: '<script src="/display/display.def4567890.js"></script>',
  controllerStyles: '<link rel="stylesheet" href="/controller/controller.aaaaaaaaaa.css">',
  displayStyles: '<link rel="stylesheet" href="/display/display.bbbbbbbbbb.css">',
};

test('renderShell expands every placeholder kind', () => {
  const html =
    '<meta name="app-version" content="__APP_VERSION__">' +
    '<link href="/shared/fonts/baloo2.css?v=__APP_V__">' +
    '<!--CONTROLLER_SCRIPTS--><!--CONTROLLER_STYLES-->';
  const out = renderShell(html, SUBS);
  assert.equal(
    out,
    '<meta name="app-version" content="4.2.0 (#abc1234)">' +
    '<link href="/shared/fonts/baloo2.css?v=4.2.0">' +
    SUBS.controllerScripts + SUBS.controllerStyles
  );
  assert.ok(!out.includes('__APP'));
  assert.ok(!out.includes('<!--'));
});

test('renderShell replaces all occurrences of a repeated placeholder', () => {
  assert.equal(renderShell('__APP_V__/__APP_V__', SUBS), '4.2.0/4.2.0');
});

test('renderShell is a no-op pass-through when no placeholders are present', () => {
  const html = '<!doctype html><title>Imprint</title><body>legal text</body>';
  assert.equal(renderShell(html, SUBS), html);
});

test('renderShell is idempotent — re-rendering already-rendered HTML changes nothing', () => {
  const html =
    '<meta content="__APP_VERSION__"><!--DISPLAY_SCRIPTS--><!--DISPLAY_STYLES-->';
  const once = renderShell(html, SUBS);
  assert.equal(renderShell(once, SUBS), once);
});
