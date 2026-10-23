'use strict';

// =====================================================================
// Paper Balloon Controller Bootstrap
// Loaded after ControllerConnection.js / ControllerGame.js (it wraps their
// globals at load time) but BEFORE controller.js init. Self-gated on
// window.PaperBalloonHost, which only the launcher defines, so this file is inert
// in plain browsers and gallery iframes; the AirConsole build strips it.
// The contract is CONTRACT.md in the PaperBalloon-Controller repo.
//
// The launcher owns the player's name, so the name screen is skipped and the
// name on the lobby card opens the launcher's sheet (the only rename there
// is). Everything else runs as in a browser, with these hooks:
//   PaperBalloonHost.name                 the player's name, always current
//   PaperBalloonHost.editName()           the launcher's rename sheet → name | null
//   PaperBalloonHost.leave()              leaving, instead of navigating
//   PaperBalloonHost.gameEnded(reason)    terminal end, instead of navigating
//     reason: 'game_ended' | 'room_not_found' | 'game_full' | 'replaced'
//   PaperBalloonHost.setBackMode(m)       where a system back goes
//     m: 'off' | 'page' | 'leave'
//   window.PaperBalloon.back()            a back gesture in 'page' mode
//   PaperBalloonHost.haptic(p, scale)     play a haptic primitive
// =====================================================================

(function () {
  var host = window.PaperBalloonHost;
  if (!host) return;

  document.body.classList.add('paperballoon');

  // --- Name ---
  // Take the auto-connect branch in controller.js init: the name screen shows
  // only its connecting state.
  skipNameScreen = true;

  // HELLO with the launcher's name on every (re)connect. It is deliberately
  // NOT written to stacker_player_name: that key is the name typed in a plain
  // browser. clientId IS persisted (mirroring submitName, which the skipped
  // name screen never runs) so a WebView reload mid-session reconnects into
  // the same player slot instead of joining as a fresh player.
  var _originalConnect = connect;
  connect = function () {
    playerName = host.name;
    playerNameIsAuto = false;
    try {
      // A player is only in one room at a time — clean up other rooms' ids.
      for (var i = localStorage.length - 1; i >= 0; i--) {
        var key = localStorage.key(i);
        if (key && key.indexOf('clientId_') === 0 && key !== 'clientId_' + roomCode) {
          localStorage.removeItem(key);
        }
      }
      localStorage.setItem('clientId_' + roomCode, clientId);
    } catch (e) { /* WebView storage disabled */ }
    _originalConnect();
  };

  // The name on the lobby card opens the launcher's name sheet, which styles
  // itself from the page's color-scheme/theme-color metas and :root
  // accent-color (applyPlayerColor). A null result is a dismissal, which
  // applyLiveRename ignores; a name is already the launcher's, so only the
  // display needs it.
  enableShellRename(function () { host.editName().then(applyLiveRename); });

  // --- Leaving ---
  // Every exit from the room closes the web view, which ends the relay socket
  // too, so there is nothing to send or clean up first. (The browser-back
  // path into performDisconnect never fires here: the launcher owns back.)
  // The buttons show an X here (body.paperballoon) rather than the browser's back
  // chevron, so relabel them to match.
  performDisconnect = function () { host.leave(); };
  document.querySelectorAll('.leave-btn').forEach(function (btn) {
    btn.setAttribute('data-i18n-aria-label', 'leave_game');
    btn.setAttribute('aria-label', t('leave_game'));
  });

  // Terminal session end → hand control back to the launcher instead of
  // location.replace('/?bail=…'). Until the launcher pops the web view, this
  // page must not keep pinging a room it considers dead.
  bailToWelcome = function (toastKey, keepClientId) {
    if (gameCancelled) return;
    gameCancelled = true;
    stopPing();
    cancelFastlaneReopen();
    if (fastlane) { fastlane.closeAll(); fastlane = null; }
    if (party) { party.close(); party = null; }
    if (!keepClientId) {
      try { localStorage.removeItem('clientId_' + roomCode); } catch (e) { /* WebView storage disabled */ }
    }
    // keepClientId=true is only ever passed on the replaced-by-newer-tab
    // close (party.onClose meta.replaced), which carries no toastKey.
    host.gameEnded(toastKey || (keepClientId ? 'replaced' : 'game_ended'));
  };

  // --- Haptics ---
  // The launcher plays HAPTIC_EFFECTS' primitives natively, at a real
  // strength, where navigator.vibrate only varies pulse length.
  playHaptic = function (primitive, scale) { host.haptic(primitive, scale); };

  // --- System back ---
  // Back yields the screen edges to the system, so it is 'off' during a live
  // game where an edge swipe is a drag input. A dialog takes it as 'page'
  // (back closes the dialog; Android only, iOS never steps back inside the
  // page); wherever a leave button is the way out it is 'leave', exiting like
  // the X.
  function isOpen(el) {
    return !!el && !el.classList.contains('hidden');
  }

  // The pause overlay lives inside the game screen and is not always cleared
  // on the way out (a game that ends while paused goes straight to results),
  // so its class alone doesn't mean the player is looking at it.
  function pauseOpen() {
    return currentScreen === 'game' && isOpen(pauseOverlay);
  }

  var backMode = null;
  function syncSystemBack() {
    var want = 'off';
    if (isOpen(settingsOverlay) || isOpen(colorPickerOverlay) || pauseOpen()) want = 'page';
    else if (isOpen(reconnectOverlay) || currentScreen !== 'game') want = 'leave';
    if (want === backMode) return;
    backMode = want;
    host.setBackMode(want);
  }

  // Dialogs open and close from a dozen places (buttons, room snapshots, the
  // reconnect path, the test harness); the `hidden` class is the one thing
  // every path agrees on, so watch that instead of wrapping each caller.
  var overlayWatch = new MutationObserver(syncSystemBack);
  [settingsOverlay, colorPickerOverlay, pauseOverlay, reconnectOverlay].forEach(function (el) {
    overlayWatch.observe(el, { attributes: true, attributeFilter: ['class'] });
  });
  var _originalShowScreen = showScreen;
  showScreen = function (name) {
    _originalShowScreen(name);
    syncSystemBack();
  };
  syncSystemBack();

  // Called by the launcher once per gesture, only in 'page' mode. Anything but
  // a literal true leaves the game. Settings first: it can sit on top of the
  // pause overlay. hideSettings is block-scoped in controller.js, so the
  // window alias is the only handle.
  window.PaperBalloon = {
    back: function () {
      if (isOpen(settingsOverlay)) { window.closeSettingsOverlay(); return true; }
      if (isOpen(colorPickerOverlay)) { closeColorPicker(); return true; }
      if (pauseOpen()) { sendToDisplay(MSG.RESUME_GAME); return true; }
      return false;
    }
  };
})();
