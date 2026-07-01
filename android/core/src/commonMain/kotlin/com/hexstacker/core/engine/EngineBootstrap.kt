package com.hexstacker.core.engine

/**
 * The JS shim installed AFTER evaluating `dist/partycore.js` (which defines
 * `globalThis.HexCore`). Mirrors `EngineBridge.swift`'s `bootstrapJS`, but
 * references `HexCore.PartyCore` (the esbuild iife) instead of
 * `window.GameEngine.PartyCore`, and installs `Bridge` on `globalThis`.
 *
 * `create` reassigns `core`, so ONE bridge is reusable across matches: call
 * `createGame(...)` again to start a new game without re-parsing the bundle.
 */
internal object EngineBootstrap {
    val SHIM: String = """
    globalThis.Bridge = (function () {
      var PartyCore = HexCore.PartyCore;
      var core = null;
      return {
        create: function (specs, seed) {
          var map = new Map();
          for (var i = 0; i < specs.length; i++) {
            map.set(specs[i][0], { startLevel: specs[i][1] });
          }
          core = new PartyCore(map, seed >>> 0);
          core.init();
        },
        processInput: function (pid, action) { if (core) core.processInput(pid, action); },
        softDropStart: function (pid, speed) {
          if (core) core.handleSoftDropStart(pid, (speed === undefined ? null : speed));
        },
        softDropEnd: function (pid) { if (core) core.handleSoftDropEnd(pid); },
        update: function (dt) { if (core) core.update(dt); },
        pause: function () { if (core) core.pause(); },
        resume: function () { if (core) core.resume(); },
        resetFrameClock: function () { if (core) core.resetFrameClock(); },
        rekey: function (oldId, newId) { return !!(core && core.rekey(oldId, newId)); },
        snapshotJSON: function () { return JSON.stringify(core.snapshot()); },
        drainEventsJSON: function () { return JSON.stringify(core.drainEvents()); },
        frameJSON: function (now) { return JSON.stringify(core.frame(now)); },
        isEnded: function () { return !!(core && core.game && core.game.ended); }
      };
    })();
    """.trimIndent()
}
