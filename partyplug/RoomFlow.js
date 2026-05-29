'use strict';

// =====================================================================
// RoomFlow — headless room/lobby/host state machine for PartyPlug.
//
// Owns: room state (lobby -> countdown -> playing -> results), the player
// roster (identity + join order + presence), sticky-host election, and
// disconnection tracking. Emits events; the view subscribes and renders.
// The countdown itself is game-owned (its visuals + controller messaging are
// game-flavored); RoomFlow only models the COUNTDOWN state.
//
// Knows NOTHING about: the DOM, canvases, QR codes, the relay/transport,
// or any specific game's concepts. In particular it has NO notion of player
// color, name, score, or level — those are game data. A player record is
// `{ peerIndex, joinedAt, connected, ...gameFields }`: RoomFlow owns the
// first three and treats everything the game passes to addPlayer() as
// opaque fields it stores but never reads. The game mutates those fields on
// the record object directly (get() returns the live object).
//
// The only things RoomFlow reads off a player are `joinedAt` (host-election
// tiebreak) and presence (the `_disconnected` set). That is what keeps it
// reusable across games that look nothing like each other.
//
// Extracted from public/display/DisplayState.js (the roomState machine, the
// players map, and the getHostPeerIndex / electNextHost / reconcileStickyHost
// trio) with three changes that make it transport-, DOM-, and game-agnostic:
//   1. The AirConsole master-controller rule is injected as `masterProvider`.
//   2. Disconnection is a Set, not the disconnectedQRs DOM map.
//   3. Color/name/level slot logic is removed — pure game data now.
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
    // Optional () => peerIndex. When the transport designates a master
    // controller (AirConsole), supply it here. Returns null/undefined when
    // there is no platform master.
    this.masterProvider = typeof opts.masterProvider === 'function' ? opts.masterProvider : null;

    this.state = STATES.LOBBY;
    this.players = new Map();        // peerIndex -> player record
    this.hostPeerIndex = null;       // sticky host slot (raw; see `host` getter for effective)
    this._joinSeq = 0;               // monotonic joinedAt source (Date.now collides in same ms)
    this._disconnected = new Set();  // peerIndices currently in the disconnect window
    this._order = [];                // active participants (snapshotted on COUNTDOWN, or via setActiveOrder)
    this._listeners = {};
    this.lastResults = null;
  }

  RoomFlow.STATES = STATES;

  // Lowest free dense slot in [0, max) given the slots already in use. Pure
  // and sparse-safe: callers pass the *slot values* in use (not peerIndices),
  // so a non-contiguous transport id (e.g. an AirConsole device_id) is never
  // mistaken for a dense seat/color index. Returns -1 when full. Both the
  // display and any controller-seat allocator should route through this rather
  // than reinventing it (and rather than indexing a palette by peerIndex).
  RoomFlow.lowestFreeSlot = function (used, max) {
    var taken = used instanceof Set ? used : new Set(used);
    for (var i = 0; i < max; i++) { if (!taken.has(i)) return i; }
    return -1;
  };

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

  // Add a player, or reconnect/refresh an existing one (same peerIndex).
  // `fields` is opaque game data merged onto the record (name, color slot,
  // level, ...). RoomFlow adds peerIndex/joinedAt/connected and never reads
  // the game fields. Returns the live player record.
  RoomFlow.prototype.addPlayer = function (peerIndex, fields) {
    fields = fields || {};
    var existing = this.players.get(peerIndex);
    if (existing) {
      // Reconnect: keep slot / joinedAt / host, refresh presence + fields.
      Object.assign(existing, fields);
      existing.connected = true;
      this._disconnected.delete(peerIndex);
      this._emit('playerupdate', { player: existing });
      this._emit('rosterchange', { players: this.list() });
      return existing;
    }
    var player = Object.assign({}, fields, {
      peerIndex: peerIndex,
      joinedAt: this._joinSeq++,
      connected: true,
    });
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
    var oi = this._order.indexOf(peerIndex);
    if (oi >= 0) this._order.splice(oi, 1);
    if (wasHost && (this.state === STATES.LOBBY || this.state === STATES.RESULTS)) {
      this.hostPeerIndex = this._electNextHost(peerIndex);
      this._emit('hostchange', { hostPeerIndex: this.host });
    }
    this._emit('playerleave', { peerIndex: peerIndex });
    this._emit('rosterchange', { players: this.list() });
  };

  // Re-key a player from one peerIndex to another. This is ONLY for cross-device
  // takeover: a different client (fresh clientId) claims a dropped player's
  // still-present slot and gets a new peerIndex from the relay. A same-client
  // reconnect keeps its index (the relay keys slots by clientId) and never needs
  // this. Preserves the record (incl. joinedAt) and rekeys host slot + order.
  RoomFlow.prototype.rekey = function (oldId, newId) {
    if (oldId === newId) return false;
    var rec = this.players.get(oldId);
    if (!rec) return false;
    this.players.delete(oldId);
    this.players.delete(newId); // drop the placeholder slot the returning peer got
    rec.peerIndex = newId;
    rec.connected = true;
    this.players.set(newId, rec);
    this._disconnected.delete(oldId);
    this._disconnected.delete(newId);
    for (var i = 0; i < this._order.length; i++) {
      if (this._order[i] === oldId) this._order[i] = newId;
    }
    // The slot wasn't moved when this player blipped mid-game, so it still
    // points at the old peerIndex; rekey it so a reconnecting host resumes.
    var prevHost = this.hostPeerIndex;
    if (this.hostPeerIndex === oldId || this.hostPeerIndex == null) {
      this.hostPeerIndex = newId;
    }
    if (this.hostPeerIndex !== prevHost) this._emit('hostchange', { hostPeerIndex: this.host });
    this._emit('rosterchange', { players: this.list() });
    return true;
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

  // Clear every disconnect flag, marking all current players present. Used at
  // game start / lobby return where stale blip flags must not suppress host
  // eligibility for the new round.
  RoomFlow.prototype.clearDisconnected = function () {
    if (this._disconnected.size === 0) return;
    this._disconnected.clear();
    for (var entry of this.players) entry[1].connected = true;
    this._emit('rosterchange', { players: this.list() });
  };

  // =====================================================================
  // Host election (DisplayState.getHostPeerIndex / electNextHost / reconcile)
  // =====================================================================

  // During COUNTDOWN/PLAYING/RESULTS the candidate set is restricted to the
  // active participants (the `_order`), so a late joiner can't be handed host
  // duty for menu actions they can't reach. Open to everyone in LOBBY.
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
  // sticky slot is only mutated by removePlayer / rekey / reconcile.
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

  // Snapshot the current connected roster as the active participant order
  // (join order). Called automatically when entering COUNTDOWN.
  RoomFlow.prototype._snapshotOrder = function () {
    var active = [];
    for (var entry of this.players) {
      if (!this._disconnected.has(entry[0])) active.push(entry[1]);
    }
    active.sort(function (a, b) { return a.joinedAt - b.joinedAt; });
    this._order = active.map(function (p) { return p.peerIndex; });
  };

  // Let a game that maintains its own participant order (e.g. for board
  // layout) keep RoomFlow's host-eligibility set exactly in sync with it.
  RoomFlow.prototype.setActiveOrder = function (peerIndices) {
    var out = [];
    for (var i = 0; i < (peerIndices || []).length; i++) {
      if (this.players.has(peerIndices[i])) out.push(peerIndices[i]);
    }
    this._order = out;
  };

  // Validated state transition. Public so games that run their own countdown
  // (like HexStacker) can drive the machine imperatively; the high-level
  // helpers below call it too. Returns true if applied.
  RoomFlow.prototype.transitionTo = function (to) {
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

  // Lifecycle helpers — thin, validated transitions. The countdown itself is
  // game-owned (its visuals and controller messaging are game-flavored): a game
  // drives transitionTo(COUNTDOWN) -> run its own countdown -> transitionTo(PLAYING).

  RoomFlow.prototype.endGame = function (results) {
    this.lastResults = results != null ? results : this.lastResults;
    return this.transitionTo(STATES.RESULTS);
  };

  RoomFlow.prototype.returnToLobby = function () {
    return this.transitionTo(STATES.LOBBY);
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
  // roster/host/state portion of DisplayState.resetRoomData.
  RoomFlow.prototype.reset = function () {
    // IMPORTANT: clear the Map in place — never reassign `this.players`.
    // Consumers may alias this exact Map object as their roster (HexStacker's
    // DisplayState does), so reassigning would leave them on a stale Map.
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
