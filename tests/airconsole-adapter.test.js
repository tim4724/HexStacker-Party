'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// AirConsole is referenced at constructor time for the SCREEN constant; expose
// a minimal global before requiring the adapter.
global.AirConsole = { SCREEN: 0 };

const AirConsoleAdapter = require('../public/shared/AirConsoleAdapter');

function makeFakeAirConsole(overrides) {
  return Object.assign({
    _master: undefined,
    getMasterControllerDeviceId() { return this._master; },
    getControllerDeviceIds() { return []; },
    message() {},
    broadcast() {},
  }, overrides || {});
}

describe('AirConsoleAdapter.getMasterClientId', () => {
  it('returns null when no controller is connected', () => {
    const ac = makeFakeAirConsole();
    const adapter = new AirConsoleAdapter(ac, { role: 'display' });
    assert.equal(adapter.getMasterClientId(), null);
  });

  it('returns String(master device id) when present', () => {
    const ac = makeFakeAirConsole({ _master: 7 });
    const adapter = new AirConsoleAdapter(ac, { role: 'display' });
    assert.equal(adapter.getMasterClientId(), '7');
  });

  it('returns null from the controller role', () => {
    const ac = makeFakeAirConsole({ _master: 7 });
    const adapter = new AirConsoleAdapter(ac, { role: 'controller' });
    assert.equal(adapter.getMasterClientId(), null);
  });
});

describe('AirConsoleAdapter onPremium', () => {
  it('fires master_changed protocol event on display', () => {
    const ac = makeFakeAirConsole();
    const adapter = new AirConsoleAdapter(ac, { role: 'display' });
    const seen = [];
    adapter.onProtocol = function(type, msg) { seen.push({ type, msg }); };
    ac.onPremium();
    assert.equal(seen.length, 1);
    assert.equal(seen[0].type, 'master_changed');
  });

  it('does not fire master_changed from the controller role', () => {
    const ac = makeFakeAirConsole();
    const adapter = new AirConsoleAdapter(ac, { role: 'controller' });
    const seen = [];
    adapter.onProtocol = function(type) { seen.push(type); };
    ac.onPremium();
    assert.deepEqual(seen, []);
  });
});
