'use strict';

// Canonical browser script load order for each web app entry, single-sourced so
// the build (concatenation) and the server (dev-mode injection of individual
// tags) can never disagree. These lists ARE the order; the app index.html files
// just carry a <!--CONTROLLER_SCRIPTS--> / <!--DISPLAY_SCRIPTS--> placeholder.
//
// The per-app test harness is included here in its load-order position (the
// display's must precede display.js, which reads window.__TEST__ at init). It is
// URL-param-gated, so it's inert for real players, and the e2e suite drives the
// display through that harness against the bundle, so it has to ship in it. The
// AirConsole generator strips it from the AC entry via its TestHarness.js regex.
//
// Paths are browser URL paths. resolveAsset() maps them to disk:
//   /engine/*    -> server/*      (UMD engine, also used by node --test)
//   /partyplug/* -> partyplug/*
//   /shared/*, /controller/*, /display/*  -> public/*

const path = require('path');
const ROOT = path.join(__dirname, '..');

const CONTROLLER_SCRIPTS = [
  '/engine/constants.js',
  '/engine/Piece.js',
  '/partyplug/PartyConnection.js',
  '/partyplug/PartyFastlane.js',
  '/partyplug/AirConsoleAdapter.js',
  '/partyplug/AirConsoleStorage.js',
  '/shared/protocol.js',
  '/shared/i18n.js',
  '/shared/i18n-fallback.js',
  // CanvasUtils before theme: theme.js eagerly calls ghostColor() (defined here)
  // under a `typeof ghostColor === 'function'` guard. As separate <script>s that
  // guard is false in the controller (CanvasUtils loaded later) and GHOST_COLORS
  // is filled lazily; concatenated, the function declaration hoists so the guard
  // passes and runs before CanvasUtils' _ghostColorCache Map is initialized. This
  // dependency-correct order (the one the display already uses) avoids that.
  '/shared/CanvasUtils.js',
  '/shared/theme.js',
  '/shared/WelcomeBackground.js',
  '/shared/share-helper.js',
  '/controller/TouchInput.js',
  '/controller/Audio.js',
  '/controller/Settings.js',
  '/controller/ControllerState.js',
  '/controller/ControllerConnection.js',
  '/controller/ControllerGame.js',
  // Couch Games shell bootstrap (Android TV launcher WebView). Self-gated on
  // ?cgv=1 so it's inert everywhere else. Must follow ControllerConnection/
  // ControllerGame (wraps connect/bailToWelcome at load time) and precede
  // controller.js (whose init reads skipNameScreen). The AirConsole generator
  // strips it from the AC entry.
  '/controller/controller-couchgames.js',
  '/controller/controller.js',
  // Gallery/test harness, kept last (as it was a separate tag). Self-gated on
  // ?scenario= so it's inert for real players; folded in for one atomic bundle.
  // The AirConsole generator strips it from the AC entry.
  '/controller/ControllerTestHarness.js',
];

const DISPLAY_SCRIPTS = [
  '/engine/constants.js',
  '/engine/Randomizer.js',
  '/engine/GarbageManager.js',
  '/engine/Piece.js',
  '/engine/PlayerBoard.js',
  '/engine/Game.js',
  '/engine/PartyCore.js',
  '/engine/GalleryFixtures.js',
  '/partyplug/PartyConnection.js',
  '/partyplug/PartyFastlane.js',
  '/partyplug/AirConsoleAdapter.js',
  '/partyplug/AirConsoleStorage.js',
  '/partyplug/RoomFlow.js',
  '/shared/protocol.js',
  '/shared/i18n.js',
  '/shared/i18n-fallback.js',
  '/shared/CanvasUtils.js',
  '/shared/theme.js',
  '/shared/WelcomeBackground.js',
  '/shared/share-helper.js',
  '/display/BoardRenderer.js',
  '/display/UIRenderer.js',
  '/display/Animations.js',
  '/display/Music.js',
  '/display/DisplayState.js',
  '/display/DisplayUI.js',
  '/display/DisplayConnection.js',
  '/display/DisplayAudio.js',
  '/display/DisplayGame.js',
  '/display/DisplayLiveness.js',
  '/display/DisplayInput.js',
  '/display/DisplayRender.js',
  // Must precede display.js: its bottom-of-file init reads window.__TEST__
  // (set here under ?test/?scenario/?adclip) synchronously to choose
  // scenario-vs-relay. Inert for real users; AC generator strips it.
  '/display/DisplayTestHarness.js',
  '/display/display.js',
];

function resolveAsset(urlPath) {
  if (urlPath.indexOf('/engine/') === 0) {
    return path.join(ROOT, 'server', urlPath.slice('/engine/'.length));
  }
  if (urlPath.indexOf('/partyplug/') === 0) {
    return path.join(ROOT, urlPath.slice(1));
  }
  return path.join(ROOT, 'public', urlPath.slice(1));
}

module.exports = {
  ROOT: ROOT,
  CONTROLLER_SCRIPTS: CONTROLLER_SCRIPTS,
  DISPLAY_SCRIPTS: DISPLAY_SCRIPTS,
  resolveAsset: resolveAsset,
};
