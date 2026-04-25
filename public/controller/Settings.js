'use strict';

// =====================================================================
// Controller Settings — per-device preferences persisted to localStorage.
// Applied to ControllerAudio (mute), TouchInput (ratchet threshold), and
// the global vibrate() helper (haptic strength). Load order: after
// TouchInput + Audio, before ControllerState so `vibrate()` can consult it.
// AirConsole mode: window.localStorage is replaced by an AC-backed shim
// (see AirConsoleAdapter.installAirConsoleStorage) so the same code path
// transparently persists per-UID via the AirConsole SDK. The shim's cache
// hydrates async; controller-airconsole.js calls reload() once data lands.
// =====================================================================

var ControllerSettings = (function () {
  // Distinct from the display's `stacker_muted` (which controls music and
  // resets every session). This one persists the controller's touch-sound
  // mute, so e.g. ControllerAudio.tick / drop / hold stay quiet on next join.
  var KEY_TOUCH_SOUNDS = 'stacker_touch_sounds';
  var KEY_HAPTIC = 'stacker_haptic_strength';
  var KEY_SENSITIVITY = 'stacker_touch_sensitivity';

  var HAPTIC_TIERS = ['off', 'light', 'medium', 'strong'];
  // Web vibration only exposes duration, not amplitude, so "stronger" means
  // longer pulses. Medium is 1.0 by convention — raw pattern values at each
  // call site are therefore the Medium-tier ms. Light and Strong are plain
  // multipliers around it.
  var HAPTIC_SCALE = { off: 0, light: 0.6, medium: 1, strong: 1.8 };

  // Absolute clamp for persisted values. The UI slider narrows this further
  // to [touchpadWidth * 0.1, touchpadWidth * 0.5] each time Settings opens
  // so the range always matches the available drag distance on this device.
  // Upper bound deliberately tight: at 200px, TAP_MAX_DISTANCE in TouchInput
  // would hit 60px (vs 15 at default) which already makes rotation demanding
  // — any higher and taps become nearly impossible. Wide landscape tablets
  // max out at ~180px via the slider formula anyway.
  var SENSITIVITY_MIN = 10;
  var SENSITIVITY_MAX = 200;
  var SENSITIVITY_DEFAULT = 48; // matches TouchInput.RATCHET_THRESHOLD

  // Display format for the sensitivity value. The slider remains a log-scaled
  // abstract position driven by touchpad width; only the user-facing number
  // is the scaled multiplier (px / SENSITIVITY_DEFAULT). Snapped to 0.05 so
  // the displayed digits don't jitter between neighbouring integer-rounded
  // px values (e.g. 50/48 = 1.0417 reads as 1.05 instead of 1.04).
  var SENSITIVITY_SCALE_STEP = 0.05;

  function formatSensitivityScale(px) {
    var scaled = px / SENSITIVITY_DEFAULT;
    var snapped = Math.round(scaled / SENSITIVITY_SCALE_STEP) * SENSITIVITY_SCALE_STEP;
    return snapped.toFixed(2);
  }

  var state = {
    muted: false,
    haptic: 'medium',
    sensitivity: SENSITIVITY_DEFAULT
  };

  var listeners = [];

  function read(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function write(key, val) {
    try { localStorage.setItem(key, val); } catch (e) { /* iframe sandbox */ }
  }

  function load() {
    state.muted = read(KEY_TOUCH_SOUNDS) === '1';
    var h = read(KEY_HAPTIC);
    state.haptic = HAPTIC_TIERS.indexOf(h) >= 0 ? h : 'medium';
    var s = parseInt(read(KEY_SENSITIVITY), 10);
    state.sensitivity = (!isNaN(s) && s >= SENSITIVITY_MIN && s <= SENSITIVITY_MAX)
      ? s
      : SENSITIVITY_DEFAULT;
  }

  function applyToSubsystems() {
    if (typeof ControllerAudio !== 'undefined' && ControllerAudio.setMuted) {
      ControllerAudio.setMuted(state.muted);
    }
    if (typeof touchInput !== 'undefined' && touchInput && touchInput._applySensitivity) {
      touchInput._applySensitivity(state.sensitivity);
    }
  }

  function notify() {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](state); } catch (e) { console.error('[settings] listener', e); }
    }
  }

  function init() {
    load();
    applyToSubsystems();
  }

  // Re-read from storage and re-apply. In AirConsole mode the storage shim
  // hydrates async; the bootstrap calls reload() once onPersistentDataLoaded
  // populates the cache so user settings overwrite the defaults applied at
  // page load.
  function reload() {
    load();
    applyToSubsystems();
    notify();
  }

  function setMuted(val) {
    var next = !!val;
    if (next === state.muted) return;
    state.muted = next;
    write(KEY_TOUCH_SOUNDS, state.muted ? '1' : '0');
    if (typeof ControllerAudio !== 'undefined' && ControllerAudio.setMuted) {
      ControllerAudio.setMuted(state.muted);
    }
    notify();
  }

  function setHapticStrength(tier) {
    if (HAPTIC_TIERS.indexOf(tier) < 0) return;
    if (tier === state.haptic) return;
    state.haptic = tier;
    write(KEY_HAPTIC, tier);
    notify();
  }

  function setSensitivity(px) {
    var n = parseInt(px, 10);
    if (isNaN(n)) return;
    n = Math.max(SENSITIVITY_MIN, Math.min(SENSITIVITY_MAX, n));
    if (n === state.sensitivity) return;
    state.sensitivity = n;
    write(KEY_SENSITIVITY, String(n));
    // Live-apply to the active TouchInput instance if present. Calls the
    // derived-threshold method so TAP / SOFT_DROP / FLICK all retune too.
    if (typeof touchInput !== 'undefined' && touchInput && touchInput._applySensitivity) {
      touchInput._applySensitivity(n);
    }
    notify();
  }

  // Scale a vibration pattern by the configured haptic strength.
  // Returns null when the user has picked the 'off' tier. Callers are
  // expected to guard `navigator.vibrate` existence themselves — feature
  // detection on this API is unreliable across devices, so we just pass
  // the pattern through and let the platform decide.
  // Enforces a 3ms floor so 'light' tier never produces patterns too
  // short for some hardware to trigger.
  function scaleVibration(pattern) {
    var scale = HAPTIC_SCALE[state.haptic];
    if (scale <= 0) return null;
    if (Array.isArray(pattern)) {
      return pattern.map(function (p) { return Math.max(3, Math.round(p * scale)); });
    }
    return Math.max(3, Math.round(pattern * scale));
  }

  function onChange(cb) {
    if (typeof cb === 'function') listeners.push(cb);
  }

  return {
    init: init,
    reload: reload,
    isMuted: function () { return state.muted; },
    setMuted: setMuted,
    getHapticStrength: function () { return state.haptic; },
    setHapticStrength: setHapticStrength,
    getSensitivity: function () { return state.sensitivity; },
    setSensitivity: setSensitivity,
    scaleVibration: scaleVibration,
    onChange: onChange,
    SENSITIVITY_MIN: SENSITIVITY_MIN,
    SENSITIVITY_MAX: SENSITIVITY_MAX,
    SENSITIVITY_DEFAULT: SENSITIVITY_DEFAULT,
    SENSITIVITY_SCALE_STEP: SENSITIVITY_SCALE_STEP,
    formatSensitivityScale: formatSensitivityScale,
    HAPTIC_TIERS: HAPTIC_TIERS
  };
})();

if (typeof window !== 'undefined') {
  window.ControllerSettings = ControllerSettings;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ControllerSettings;
}
