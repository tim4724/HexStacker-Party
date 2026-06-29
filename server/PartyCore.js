'use strict';

// UMD: works in Node.js (require), the browser (window.GameEngine.PartyCore),
// and JavaScriptCore/QuickJS on native (tvOS / Android TV). Pure: no wall clock,
// no timers, no DOM, no I/O — time is injected via nowMs.
//
// PartyCore WRAPS a stateful Game and exposes the PULL-ONLY native integration
// surface. It inverts Game's host-callback push (onEvent/onGameEnd) into a
// drained, ordered, plain-serializable events array; returns a VALUE-COPY
// snapshot (deep-cloning the live mutable refs Game.getSnapshot hands back so a
// host can RETAIN it across frames); and normalizes this frame's events +
// snapshot into a host-effect commands list (no protocol.js coupling — the host
// maps type -> MSG/sendTo/animation).
//
// frame(nowMs) wraps the ENGINE per-frame work only. RoomFlow liveness is a
// separate 1Hz pull and is deliberately NOT folded in here (folding a 1Hz
// decision into the 60Hz frame would change its cadence and force a
// server/->partyplug/ dependency). update()/snapshot()/drainEvents() stay
// individually callable for the native granular path.
(function(exports) {

var Game = ((typeof require !== 'undefined') ? require('./Game.js') : window.GameEngine).Game;

// Cap frame delta to ~3 frames at 60Hz — prevents huge catch-up jumps after a
// tab unfreeze / native app resume. Single source of truth for the cap; the web
// rAF loop (DisplayRender.js) sources it from here.
var MAX_FRAME_DELTA_MS = 50;

// JSON round-trip clone. Engine events are plain serializable data, so this both
// de-aliases the live refs Game hands to onEvent and guarantees a host-portable
// payload.
function clone(x) {
  return JSON.parse(JSON.stringify(x));
}

// Deep value-copy of one Game.getSnapshot() player state. getSnapshot returns
// LIVE MUTABLE references — grid rows aliased to the board, currentPiece.blocks /
// ghost.blocks reuse per-call scratch arrays, clearingCells a board cache — so a
// host that retains a snapshot across frames MUST copy every such ref. Scalars
// are copied by value. cells is mutated in place only on freshly-cloned pieces
// during rotation (Piece._setCells); PlayerBoard swaps currentPiece by reference
// rather than mutating the live piece, so a retained snapshot's cells objects are
// never touched again — a shallow slice is sufficient.
function copyPlayer(s) {
  return {
    id: s.id,
    grid: s.grid.map(function(row) { return row.slice(); }),
    currentPiece: s.currentPiece ? {
      type: s.currentPiece.type,
      typeId: s.currentPiece.typeId,
      anchorCol: s.currentPiece.anchorCol,
      anchorRow: s.currentPiece.anchorRow,
      cells: s.currentPiece.cells.slice(),
      blocks: s.currentPiece.blocks.map(function(b) { return [b[0], b[1]]; })
    } : null,
    ghost: s.ghost ? {
      anchorCol: s.ghost.anchorCol,
      anchorRow: s.ghost.anchorRow,
      blocks: s.ghost.blocks.map(function(b) { return [b[0], b[1]]; })
    } : null,
    holdPiece: s.holdPiece,
    nextPieces: s.nextPieces.slice(),
    level: s.level,
    lines: s.lines,
    alive: s.alive,
    pendingGarbage: s.pendingGarbage,
    clearingCells: s.clearingCells
      ? s.clearingCells.map(function(c) { return [c[0], c[1]]; })
      : null,
    gridVersion: s.gridVersion
  };
}

function PartyCore(players, seed) {
  var self = this;
  this._buf = [];
  this._prevNowMs = null;
  this._lastMusicLevel = 0;
  // Game pushes synchronously into our buffer; we surface it on the next drain.
  // This inverts the host-callback push into a PULL-ONLY drained array, folding
  // the SEPARATE onGameEnd terminal callback into the same ordered buffer.
  this.game = new Game(players, {
    onEvent: function(e) { self._buf.push(clone(e)); },
    onGameEnd: function(r) {
      self._buf.push(clone({ type: 'game_end', elapsed: r.elapsed, results: r.results }));
    }
  }, seed);
}

PartyCore.MAX_FRAME_DELTA_MS = MAX_FRAME_DELTA_MS;

PartyCore.prototype.init = function() {
  return this.game.init();
};

// Input passthroughs. Their synchronous engine events accumulate in _buf and
// surface at the next drainEvents()/frame() — matching the web's between-frame
// processInput accumulation.
PartyCore.prototype.processInput = function(playerId, action) {
  return this.game.processInput(playerId, action);
};
PartyCore.prototype.handleSoftDropStart = function(playerId, speed) {
  return this.game.handleSoftDropStart(playerId, speed);
};
PartyCore.prototype.handleSoftDropEnd = function(playerId) {
  return this.game.handleSoftDropEnd(playerId);
};
PartyCore.prototype.pause = function() {
  return this.game.pause();
};
PartyCore.prototype.resume = function() {
  return this.game.resume();
};

// Individually callable; native ticks the engine at vsync. Game.update
// self-gates on paused/ended.
PartyCore.prototype.update = function(deltaMs) {
  return this.game.update(deltaMs);
};

// Returns the accumulated events in emission order and resets the buffer.
PartyCore.prototype.drainEvents = function() {
  var buf = this._buf;
  this._buf = [];
  return buf;
};

// VALUE-COPY snapshot (deep-clones the live refs getSnapshot returns) so a host
// can retain it across frames. Native calls this only on gridVersion change; web
// keeps the zero-copy live-ref getSnapshot path for its within-frame render.
PartyCore.prototype.snapshot = function() {
  var snap = this.game.getSnapshot();
  return {
    players: snap.players.map(copyPlayer),
    elapsed: snap.elapsed
  };
};

// Mirror DisplayRender prevFrameTime=0 on pause/results entry: the next frame()
// re-establishes the clock with a 0 delta instead of a huge resume jump.
PartyCore.prototype.resetFrameClock = function() {
  this._prevNowMs = null;
};

// Per-frame engine work. Caps nowMs -> deltaMs, ticks the engine (which
// self-gates on paused/ended), drains both onEvent and onGameEnd into one
// ordered events array, returns a value-copy snapshot and a normalized
// host-effect commands list. The host decides WHETHER to call frame() (only
// while playing && !paused, matching the web rAF loop) and calls
// resetFrameClock() when leaving the active loop.
PartyCore.prototype.frame = function(nowMs) {
  var deltaMs = this._prevNowMs == null
    ? 0
    : Math.min(nowMs - this._prevNowMs, MAX_FRAME_DELTA_MS);
  this._prevNowMs = nowMs;
  if (deltaMs > 0) this.game.update(deltaMs);
  var events = this.drainEvents();
  var snapshot = this.snapshot();
  var commands = PartyCore._toCommands(events, snapshot, this);
  return { events: events, snapshot: snapshot, commands: commands };
};

// Normalize this frame's events + value-copy snapshot into a serializable
// host-effect list. Ordering within an event mirrors the web DisplayGame
// handler so a host replaying commands in array order reproduces today's
// effects. garbageIncoming is pre-resolved from the snapshot (board-pending +
// delayed GarbageManager queue), removing the host's mid-event getSnapshot.
PartyCore._toCommands = function(events, snapshot, core) {
  var commands = [];
  for (var i = 0; i < events.length; i++) {
    var e = events[i];
    switch (e.type) {
      case 'piece_lock':
        commands.push({ type: 'pieceLock', playerId: e.playerId, blocks: e.blocks, typeId: e.typeId });
        break;
      case 'line_clear':
        commands.push({ type: 'lineClear', playerId: e.playerId, clearCells: e.clearCells, lines: e.lines });
        var p = null;
        for (var j = 0; j < snapshot.players.length; j++) {
          if (snapshot.players[j].id === e.playerId) { p = snapshot.players[j]; break; }
        }
        if (p) {
          commands.push({
            type: 'playerState',
            playerId: e.playerId,
            level: p.level,
            lines: p.lines,
            alive: p.alive,
            garbageIncoming: p.pendingGarbage
          });
        }
        break;
      case 'player_ko':
        // playerEliminated == "this player is out" (host sends MSG.GAME_OVER to
        // their controller); distinct from the match-end 'gameEnd' command below.
        commands.push({ type: 'playerKO', playerId: e.playerId });
        commands.push({ type: 'playerState', playerId: e.playerId, alive: false });
        commands.push({ type: 'playerEliminated', playerId: e.playerId });
        break;
      case 'garbage_cancelled':
        commands.push({ type: 'garbageCancelled', playerId: e.playerId, lines: e.lines });
        break;
      case 'garbage_sent':
        commands.push({ type: 'garbageSent', senderId: e.senderId, toId: e.toId, lines: e.lines });
        break;
      case 'game_end':
        // RAW — the host keeps roster enrichment (playerName/colorIndex/
        // newPlayer) and the actual broadcast; frame() has no roster.
        commands.push({ type: 'gameEnd', elapsed: e.elapsed, results: e.results });
        break;
    }
  }

  // Snapshot-derived music speed: emit only when the max player level changes.
  var maxLevel = 1;
  for (var k = 0; k < snapshot.players.length; k++) {
    var lvl = snapshot.players[k].level || 1;
    if (lvl > maxLevel) maxLevel = lvl;
  }
  if (snapshot.players.length > 0 && maxLevel !== core._lastMusicLevel) {
    core._lastMusicLevel = maxLevel;
    commands.push({ type: 'musicSpeed', level: maxLevel });
  }

  return commands;
};

exports.PartyCore = PartyCore;

})(typeof module !== 'undefined' ? module.exports : (window.GameEngine = window.GameEngine || {}));
