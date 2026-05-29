'use strict';

// =====================================================================
// RoomFlow — headless room/lobby/host state machine for PartyPlug.
//
// Owns: room state (lobby -> countdown -> playing -> results), the player
// roster, sticky-host election, the lobby countdown, and disconnection
// tracking. Emits events; the view subscribes and renders.
//
// Knows NOTHING about: the DOM, canvases, QR codes, the relay/transport,
// or any specific game. Game-specific per-player config (e.g. a starting
// level) lives in `player.meta`, never in the kit's own fields.
//
// This is the logic extracted from public/display/DisplayState.js — the
// roomState machine, the players map + slot assignment, and the
// getHostPeerIndex / electNextHost / reconcileStickyHost trio — with two
// changes that make it transport- and DOM-agnostic:
//   1. The AirConsole master-controller rule is injected as `masterProvider`
//      instead of calling party.getMasterPeerIndex() directly.
//   2. Disconnection is tracked as a fact (a Set) rather than inferred from
//      the disconnectedQRs DOM map.
//
// UMD: works under Node (tests) and the browser (<script src>).
// =====================================================================

(function (root, factory) {
  var RoomFlow = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = RoomFlow;
  } else {
    root.RoomFlow = RoomFlow;
  }
})(typeof self !== 'undefined' ? self : this, function () {

  var STATES = Object.freeze({
    LOBBY: 'lobby',
    COUNTDOWN: 'countdown',
    PLAYING: 'playing',
    RESULTS: 'results',
  });

  // Mirrors VALID_TRANSITIONS in DisplayState.js.
  var VALID_TRANSITIONS = {};
  VALID_TRANSITIONS[STATES.LOBBY] = [STATES.COUNTDOWN];
  VALID_TRANSITIONS[STATES.COUNTDOWN] = [STATES.PLAYING, STATES.LOBBY];
  VALID_TRANSITIONS[STATES.PLAYING] = [STATES.RESULTS, STATES.LOBBY];
  VALID_TRANSITIONS[STATES.RESULTS] = [STATES.COUNTDOWN, STATES.LOBBY];

  function RoomFlow(opts) {
    opts = opts || {};
    // Upper bound on color slots / players. Defaults generously; the host
    // (game) should pass its real cap so slot assignment and color
    // validation match the palette.
    this.maxPlayers = opts.maxPlayers || 8;
    this.countdownSeconds = opts.countdownSeconds != null ? opts.countdownSeconds : 3;
    // How long the "GO" beat lingers after the count hits zero before the
    // game actually starts (lets the view flash GO). Mirrors the goTimeout
    // in DisplayState's countdown object.
    this.goMs = opts.goMs != null ? opts.goMs : 600;
    // Optional () => peerIndex. When the transport designates a master
    // controller (AirConsole), supply it here. Returns null/undefined when
    // there is no platform master.
    this.masterProvider = typeof opts.masterProvider === 'function' ? opts.masterProvider : null;
    // Injectable timers so tests can drive the countdown deterministically.
    var timers = opts.timers || {};
    this._setTimeout = timers.setTimeout || (typeof setTimeout !== 'undefined' ? setTimeout : null);
    this._clearTimeout = timers.clearTimeout || (typeof clearTimeout !== 'undefined' ? clearTimeout : null);

    this.state = STATES.LOBBY;
    this.players = new Map();        // peerIndex -> player record
    this.hostPeerIndex = null;       // sticky host slot (raw; see `host` getter for effective)
    this._joinSeq = 0;               // monotonic joinedAt source (Date.now collides in same ms)
    this._disconnected = new Set();  // peerIndices currently in the disconnect window
    this._order = [];                // active participants snapshot (set at countdown)
    this._listeners = {};
    this._cdTimer = null;
    this.lastResults = null;
  }

  RoomFlow.STATES = STATES;

  // ---- tiny event emitter (dependency-free; portable Node + browser) ----
  RoomFlow.prototype.on = function (type, handler) {
    (this._listeners[type] = this._listeners[type] || []).push(handler);
    var self = this;
    return function () { self.off(type, handler); };
  };
  RoomFlow.prototype.off = function (type, handler) {
    var arr = this._listeners[type];
    if (!arr) return;
    var i = arr.indexOf(handler);
    if (i >= 0) arr.splice(i, 1);
  };
  RoomFlow.prototype._emit = function (type, detail) {
    var arr = this._listeners[type];
    if (arr) { var copy = arr.slice(); for (var i = 0; i < copy.length; i++) copy[i](detail); }
    var wild = this._listeners['*'];
    if (wild) { var w = wild.slice(); for (var j = 0; j < w.length; j++) w[j](type, detail); }
  };

  // =====================================================================
  // Roster
  // =====================================================================

  // Add a player, or reconnect an existing one (same peerIndex).
  // `attrs`: { name, colorIndex?, meta? }. Returns the player record.
  RoomFlow.prototype.addPlayer = function (peerIndex, attrs) {
    attrs = attrs || {};
    var existing = this.players.get(peerIndex);
    if (existing) {
      // Reconnect: keep slot / joinedAt / host, just refresh presence.
      existing.connected = true;
      this._disconnected.delete(peerIndex);
      if (attrs.name != null) existing.name = attrs.name;
      if (attrs.meta) existing.meta = Object.assign({}, existing.meta, attrs.meta);
      if (attrs.colorIndex != null) this.setColor(peerIndex, attrs.colorIndex);
      this._emit('playerupdate', { player: existing });
      this._emit('rosterchange', { players: this.list() });
      return existing;
    }
    var player = {
      peerIndex: peerIndex,
      name: attrs.name != null ? attrs.name : null,
      colorIndex: this._nextColorSlot(attrs.colorIndex),
      joinedAt: this._joinSeq++,
      connected: true,
      meta: attrs.meta ? Object.assign({}, attrs.meta) : {},
    };
    this.players.set(peerIndex, player);
    // First joiner owns the sticky host slot. Also covers the "room emptied
    // then someone joined" case (hostPeerIndex was reset to null).
    if (this.hostPeerIndex == null) {
      this.hostPeerIndex = peerIndex;
      this._emit('hostchange', { hostPeerIndex: this.host });
    }
    this._emit('playerjoin', { player: player });
    this._emit('rosterchange', { players: this.list() });
    return player;
  };

  // Hard leave (peer_left). The sticky slot only moves when the holder
  // departs from LOBBY/RESULTS; a mid-game leave leaves the slot untouched
  // so a reconnecting host reclaims it (the `host` getter falls back
  // meanwhile). Matches DisplayState's onPeerLeft / reconcileStickyHost.
  RoomFlow.prototype.removePlayer = function (peerIndex) {
    if (!this.players.has(peerIndex)) return;
    var wasHost = peerIndex === this.hostPeerIndex;
    this.players.delete(peerIndex);
    this._disconnected.delete(peerIndex);
    if (wasHost && (this.state === STATES.LOBBY || this.state === STATES.RESULTS)) {
      this.hostPeerIndex = this._electNextHost(peerIndex);
      this._emit('hostchange', { hostPeerIndex: this.host });
    }
    this._emit('playerleave', { peerIndex: peerIndex });
    this._emit('rosterchange', { players: this.list() });
  };

  // Soft disconnect window (the player record stays; presence flips false).
  RoomFlow.prototype.markDisconnected = function (peerIndex) {
    var p = this.players.get(peerIndex);
    if (!p) return;
    p.connected = false;
    this._disconnected.add(peerIndex);
    this._emit('rosterchange', { players: this.list() });
  };

  RoomFlow.prototype.markReconnected = function (peerIndex) {
    var p = this.players.get(peerIndex);
    if (!p) return;
    p.connected = true;
    this._disconnected.delete(peerIndex);
    this._emit('rosterchange', { players: this.list() });
  };

  // Set a player's color slot. Rejects out-of-range and collisions with
  // another player (mirrors the display's silent SET_COLOR validation).
  // Returns true when applied (or a no-op same-color), false when rejected.
  RoomFlow.prototype.setColor = function (peerIndex, colorIndex) {
    var p = this.players.get(peerIndex);
    if (!p) return false;
    if (!Number.isInteger(colorIndex) || colorIndex < 0 || colorIndex >= this.maxPlayers) return false;
    if (p.colorIndex === colorIndex) return true;
    for (var entry of this.players) {
      if (entry[0] !== peerIndex && entry[1].colorIndex === colorIndex) return false;
    }
    p.colorIndex = colorIndex;
    this._emit('playerupdate', { player: p });
    this._emit('rosterchange', { players: this.list() });
    return true;
  };

  // Merge game-specific per-player config (e.g. startLevel) into meta.
  RoomFlow.prototype.setMeta = function (peerIndex, patch) {
    var p = this.players.get(peerIndex);
    if (!p || !patch) return false;
    p.meta = Object.assign({}, p.meta, patch);
    this._emit('playerupdate', { player: p });
    return true;
  };

  // First free color slot, honoring a requested slot when it's free.
  RoomFlow.prototype._nextColorSlot = function (requested) {
    var used = {};
    for (var entry of this.players) used[entry[1].colorIndex] = true;
    if (Number.isInteger(requested) && requested >= 0 && requested < this.maxPlayers && !used[requested]) {
      return requested;
    }
    for (var i = 0; i < this.maxPlayers; i++) { if (!used[i]) return i; }
    return -1;
  };

  // =====================================================================
  // Host election (DisplayState.getHostPeerIndex / electNextHost / reconcile)
  // =====================================================================

  // During COUNTDOWN/PLAYING/RESULTS the candidate set is restricted to the
  // active participants snapshotted at game start, so a late joiner can't
  // be handed host duty for menu actions they can't reach. Open to everyone
  // in LOBBY.
  RoomFlow.prototype._restricted = function () {
    return (this.state === STATES.COUNTDOWN ||
            this.state === STATES.PLAYING ||
            this.state === STATES.RESULTS) && this._order.length > 0;
  };

  RoomFlow.prototype._isEligible = function (peerIndex, eligibleSet) {
    return peerIndex != null &&
      this.players.has(peerIndex) &&
      !this._disconnected.has(peerIndex) &&
      (eligibleSet == null || eligibleSet.has(peerIndex));
  };

  RoomFlow.prototype._oldestEligible = function (eligibleSet) {
    var bestId = null, bestJoin = Infinity;
    for (var entry of this.players) {
      var id = entry[0];
      if (this._disconnected.has(id)) continue;
      if (eligibleSet != null && !eligibleSet.has(id)) continue;
      var ja = entry[1].joinedAt == null ? Infinity : entry[1].joinedAt;
      if (ja < bestJoin) { bestJoin = ja; bestId = id; }
    }
    return bestId;
  };

  // Effective host: platform master (if eligible) -> sticky host (if
  // eligible) -> oldest-joined eligible present player. Read-only; the
  // sticky slot is only mutated by removePlayer / reconcileStickyHost.
  Object.defineProperty(RoomFlow.prototype, 'host', {
    get: function () {
      var restricted = this._restricted();
      var eligible = restricted ? new Set(this._order) : null;
      if (this.masterProvider) {
        var m = this.masterProvider();
        if (this._isEligible(m, eligible)) return m;
      }
      if (this._isEligible(this.hostPeerIndex, eligible)) return this.hostPeerIndex;
      return this._oldestEligible(eligible);
    },
  });

  RoomFlow.prototype.isHost = function (peerIndex) {
    return peerIndex != null && peerIndex === this.host;
  };

  // Oldest-joined present player other than excludeId. Unrestricted (used
  // when committing the sticky slot in LOBBY/RESULTS).
  RoomFlow.prototype._electNextHost = function (excludeId) {
    var nextId = null, nextJoin = Infinity;
    for (var entry of this.players) {
      if (entry[0] === excludeId) continue;
      if (this._disconnected.has(entry[0])) continue;
      var ja = entry[1].joinedAt == null ? Infinity : entry[1].joinedAt;
      if (ja < nextJoin) { nextJoin = ja; nextId = entry[0]; }
    }
    return nextId;
  };

  // Commit any pending sticky-host handoff. Called when entering LOBBY or
  // RESULTS (the moments host duty is actually exercised: Start, Play Again).
  RoomFlow.prototype._reconcileStickyHost = function () {
    if (this.players.size === 0) return;
    if (this.hostPeerIndex != null &&
        this.players.has(this.hostPeerIndex) &&
        !this._disconnected.has(this.hostPeerIndex)) {
      return;
    }
    var prev = this.hostPeerIndex;
    this.hostPeerIndex = this._electNextHost(this.hostPeerIndex);
    if (this.hostPeerIndex !== prev) this._emit('hostchange', { hostPeerIndex: this.host });
  };

  // =====================================================================
  // Lifecycle
  // =====================================================================

  RoomFlow.prototype._snapshotOrder = function () {
    var active = [];
    for (var entry of this.players) {
      if (!this._disconnected.has(entry[0])) active.push(entry[1]);
    }
    active.sort(function (a, b) { return a.joinedAt - b.joinedAt; });
    this._order = active.map(function (p) { return p.peerIndex; });
  };

  // Internal state transition with validation. Returns true if applied.
  RoomFlow.prototype._transition = function (to) {
    var from = this.state;
    if (to === from) return true;
    var allowed = VALID_TRANSITIONS[from];
    if (!allowed || allowed.indexOf(to) < 0) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('RoomFlow: invalid transition ' + from + ' -> ' + to);
      }
      return false;
    }
    this.state = to;
    if (to === STATES.COUNTDOWN) this._snapshotOrder();
    if (to === STATES.LOBBY) this._order = [];
    if (to === STATES.LOBBY || to === STATES.RESULTS) this._reconcileStickyHost();
    this._emit('statechange', { from: from, to: to });
    return true;
  };

  // Host action: LOBBY -> COUNTDOWN -> (after countdown) PLAYING.
  RoomFlow.prototype.requestStart = function () {
    if (!this._transition(STATES.COUNTDOWN)) return false;
    var self = this;
    this._runCountdown(function () {
      // Only advance if we're still counting down (not cancelled to lobby).
      if (self.state === STATES.COUNTDOWN) self._transition(STATES.PLAYING);
    });
    return true;
  };

  // Host action from results: RESULTS -> COUNTDOWN -> PLAYING.
  RoomFlow.prototype.playAgain = function () {
    if (!this._transition(STATES.COUNTDOWN)) return false;
    var self = this;
    this._runCountdown(function () {
      if (self.state === STATES.COUNTDOWN) self._transition(STATES.PLAYING);
    });
    return true;
  };

  // End of game: PLAYING -> RESULTS. `results` is opaque game data, stored
  // for reconnecting controllers to read back.
  RoomFlow.prototype.endGame = function (results) {
    this.lastResults = results != null ? results : this.lastResults;
    return this._transition(STATES.RESULTS);
  };

  RoomFlow.prototype.returnToLobby = function () {
    this._cancelCountdownTimers();
    return this._transition(STATES.LOBBY);
  };

  // Abort an in-progress countdown back to the lobby.
  RoomFlow.prototype.cancelCountdown = function () {
    this._cancelCountdownTimers();
    if (this.state === STATES.COUNTDOWN) this._transition(STATES.LOBBY);
  };

  RoomFlow.prototype._cancelCountdownTimers = function () {
    if (this._cdTimer != null && this._clearTimeout) this._clearTimeout(this._cdTimer);
    this._cdTimer = null;
  };

  // Emits 'countdown' { remaining } for each tick (countdownSeconds..1),
  // then 'go', then calls onDone after goMs.
  RoomFlow.prototype._runCountdown = function (onDone) {
    this._cancelCountdownTimers();
    var self = this;
    var remaining = this.countdownSeconds;

    function go() {
      self._emit('go', {});
      self._cdTimer = self._setTimeout(function () {
        self._cdTimer = null;
        if (onDone) onDone();
      }, self.goMs);
    }

    if (remaining <= 0) { go(); return; }
    this._emit('countdown', { remaining: remaining });
    function tick() {
      remaining -= 1;
      if (remaining > 0) {
        self._emit('countdown', { remaining: remaining });
        self._cdTimer = self._setTimeout(tick, 1000);
      } else {
        go();
      }
    }
    this._cdTimer = this._setTimeout(tick, 1000);
  };

  // =====================================================================
  // Read accessors
  // =====================================================================

  // Roster as an array sorted by join order.
  RoomFlow.prototype.list = function () {
    var arr = [];
    for (var entry of this.players) arr.push(entry[1]);
    arr.sort(function (a, b) { return a.joinedAt - b.joinedAt; });
    return arr;
  };

  RoomFlow.prototype.get = function (peerIndex) { return this.players.get(peerIndex) || null; };
  RoomFlow.prototype.has = function (peerIndex) { return this.players.has(peerIndex); };

  Object.defineProperty(RoomFlow.prototype, 'size', {
    get: function () { return this.players.size; },
  });

  // Connected player count (what a lobby "Start (N)" button should show).
  Object.defineProperty(RoomFlow.prototype, 'connectedCount', {
    get: function () {
      var n = 0;
      for (var entry of this.players) { if (!this._disconnected.has(entry[0])) n++; }
      return n;
    },
  });

  RoomFlow.prototype.isDisconnected = function (peerIndex) { return this._disconnected.has(peerIndex); };

  // Reset to a fresh room (new room / return to welcome). Mirrors the
  // roster/host/countdown portion of DisplayState.resetRoomData.
  RoomFlow.prototype.reset = function () {
    this._cancelCountdownTimers();
    this.players.clear();
    this._disconnected.clear();
    this._order = [];
    this.hostPeerIndex = null;
    this._joinSeq = 0;
    this.lastResults = null;
    this.state = STATES.LOBBY;
  };

  return RoomFlow;
});
