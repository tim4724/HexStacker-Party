'use strict';

// esbuild entry for the portable native core.
//
// Rolls the UMD engine graph (PartyCore wrapping Game ->
// Piece/PlayerBoard/GarbageManager/Randomizer/constants) plus the RoomFlow
// reducer into one iife exposing globalThis.HexCore, so a bare host JS engine
// (JavaScriptCore on tvOS, QuickJS/V8 on Android TV) can load a single artifact
// and read HexCore.PartyCore / HexCore.RoomFlow.
//
// The surface here mirrors the portable set gated by
// tests/portable-purity.test.js (PORTABLE_MODULES). The matching runtime gate,
// tests/core-bundle-runtime.test.js, bundles THIS file and runs it in a context
// with no require/window/DOM/timers to prove it stays host-injectable.
exports.PartyCore = require('./PartyCore.js').PartyCore;
exports.RoomFlow = require('../partyplug/RoomFlow.js');
