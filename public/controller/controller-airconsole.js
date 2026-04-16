'use strict';

// =====================================================================
// AirConsole Controller Bootstrap
// Loaded AFTER all normal controller scripts but BEFORE controller.js init.
// Overrides PartyConnection so that connect() — which sets up callbacks
// and calls party.connect() — works with AirConsole instead.
// =====================================================================

// Neutralize localStorage in AirConsole mode — AC manages identity, nickname,
// and resets audio state per session, so persisting anything is dead weight
// and could pick up stale values from previous sessions in the AC iframe
// storage partition. Reads return null; writes are silently dropped.
// NOTE: display-airconsole.js has the same noop — keep the two in sync.
var _acNoopStorage = {
  getItem: function() { return null; },
  setItem: function() {},
  removeItem: function() {},
  clear: function() {},
  key: function() { return null; },
  length: 0
};
try { Object.defineProperty(window, 'localStorage', { value: _acNoopStorage, configurable: true }); } catch (e) { /* read-only */ }

var airconsole = new AirConsole({
  orientation: AirConsole.ORIENTATION_PORTRAIT,
  silence_inactive_players: false
});

// Capture early onReady — the SDK may fire it before our adapter is wired up.
var _acEarlyReadyCode;
var _acEarlyReady = false;
airconsole.onReady = function(code) {
  _acEarlyReady = true;
  _acEarlyReadyCode = code;
};

// controller.js reads roomCode from location.pathname. In AirConsole the URL
// is /controller.html which gets parsed as roomCode="controller.html".
// We can't use history.replaceState because it breaks AirConsole's SDK
// location matching (isDeviceInSameLocation_ compares URLs).
// Instead, pre-set roomCode and override showEndScreen to surface errors
// via the AirConsole status overlay instead of the end screen.
// controller.js will overwrite roomCode with "controller.html" — that's fine,
// we just need to ensure the if(roomCode) block executes.

// Pre-set clientId (adapter maps real AirConsole device IDs at message time)
clientId = 'ac_controller';

// Skip the name screen — AirConsole manages identity via the SDK.
skipNameScreen = true;

// Replace PartyConnection with a factory that returns AirConsoleAdapter.
PartyConnection = function() {
  return new AirConsoleAdapter(airconsole, { role: 'controller' });
};

// Wrap connect() to inject AirConsole nickname/locale on top of the adapter's
// onReady. Re-wrap on every call — _originalConnect() creates a fresh
// AirConsoleAdapter whose _wireAirConsole overwrites ac.onReady, so a one-shot
// wrap would be silently dropped on reconnect.
var _originalConnect = connect;
connect = function() {
  if (party && party.connected) return;
  // Set nickname before connect sends HELLO (early-ready race)
  var nick = airconsole.getNickname(airconsole.getDeviceId());
  if (nick) playerName = nick;
  _originalConnect();
  var _adapterOnReady = airconsole.onReady;
  airconsole.onReady = function(code) {
    var nickname = airconsole.getNickname(airconsole.getDeviceId());
    if (nickname) playerName = nickname;
    // Prefer the user's AirConsole-profile language over navigator.language.
    // Per the AirConsole checklist: "the game and the controller may have
    // different languages" — each device uses its own. Only override the
    // initial detectLocale result when AC's language is actually supported;
    // otherwise setLocale would silently coerce to 'en' and discard a valid
    // navigator.language fallback.
    if (typeof airconsole.getLanguage === 'function') {
      var acLang = airconsole.getLanguage();
      var acCode = acLang && acLang.toLowerCase().split('-')[0];
      if (acCode && LOCALES[acCode]) { setLocale(acLang); translatePage(); }
    }
    if (_adapterOnReady) _adapterOnReady.call(airconsole, code);
  };
  // Replay the captured-early onReady into the freshly-wired adapter.
  // The SDK fires onReady at most once per session, so reconnect paths rely
  // on this manual replay to bring a new adapter to ready. Guard on
  // !party.connected so already-connected sessions don't double-fire; the
  // adapter's _fireReady is itself idempotent, so this is belt-and-suspenders.
  if (_acEarlyReady && party && !party.connected) {
    airconsole.onReady(_acEarlyReadyCode);
  }
};

// AirConsole status overlay: show "Loading..." until lobby, show errors.
var _acStatusOverlay = document.getElementById('ac-status-overlay');
var _origShowScreen = showScreen;
showScreen = function(name) {
  _origShowScreen(name);
  // Hide loading overlay once we leave the name screen
  if (_acStatusOverlay && name !== 'name') {
    _acStatusOverlay.classList.add('hidden');
  }
};

// Override showEndScreen to surface errors via the AirConsole status overlay
// instead of the end screen (AirConsole has its own home/lobby navigation).
// Still clear game state so stale incoming messages can't re-trigger game logic.
// keepClientId (second arg) is deliberately ignored — AirConsole manages
// device identity via its SDK, not via localStorage. party.close() is also
// skipped because the AirConsole adapter's lifecycle is owned by the SDK.
showEndScreen = function(toastKey /*, keepClientId */) {
  gameCancelled = true;
  stopPing();
  if (_acStatusOverlay) {
    _acStatusOverlay.textContent = toastKey ? t(toastKey) : '';
    _acStatusOverlay.classList.toggle('hidden', !toastKey);
  }
};

// Don't create history entries in the AC iframe. ControllerState.js'
// showScreen() calls history.pushState on name→lobby so standalone web users
// can swipe/back to the name screen; in AC mode that "back" target is CSS-
// hidden and AC owns iframe navigation anyway. The entry we'd push is
// exactly what a spurious popstate (SDK location check, bfcache restore,
// phone back gesture) pops to, triggering performDisconnect. Skip the push
// and there's nothing for popstate to land on. performDisconnect stays a
// no-op as belt-and-suspenders in case some other history source pops.
history.pushState = function() {};
performDisconnect = function() {};

// Route haptics through the AirConsole SDK so the iframe's permissions policy
// can't silently block vibration. Array patterns aren't supported by the SDK,
// so we fall back to navigator.vibrate — which the iframe permissions policy
// may still block silently. Accepted tradeoff: the SDK path covers the common
// single-duration cases; the array fallback is best-effort.
function _acVibrate(pattern) {
  if (typeof pattern === 'number') {
    airconsole.vibrate(pattern);
  } else if (navigator.vibrate) {
    navigator.vibrate(pattern);
  }
}
// Overrides ControllerState.js#vibrate (global) and the TouchInput prototype.
vibrate = _acVibrate;
if (window.TouchInput) TouchInput.prototype._haptic = _acVibrate;

