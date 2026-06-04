'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { INPUT } = require('../public/shared/protocol');

global.INPUT = INPUT;
Object.defineProperty(globalThis, 'navigator', {
  value: { vibrate() {} },
  configurable: true
});

const TouchInput = require('../public/controller/TouchInput.js');

function createMockElement() {
  return {
    style: {},
    addEventListener() {},
    removeEventListener() {},
    setPointerCapture() {}
  };
}

function pointerEvent(overrides) {
  return {
    button: 0,
    pointerId: 1,
    clientX: 0,
    clientY: 0,
    timeStamp: 0,
    preventDefault() {},
    ...overrides
  };
}

describe('TouchInput gesture sessions', () => {
  let actions;
  let touchInput;

  beforeEach(() => {
    actions = [];
    touchInput = new TouchInput(createMockElement(), (action, data) => {
      actions.push({ action, data });
    });
  });

  afterEach(() => {
    touchInput.destroy();
  });

  test('fresh downward flick triggers hard drop', () => {
    touchInput._onPointerDown(pointerEvent({ clientX: 0, clientY: 0, timeStamp: 0 }));
    touchInput._onPointerMove(pointerEvent({ clientX: 10, clientY: 40, timeStamp: 40 }));
    touchInput._onPointerUp(pointerEvent({ clientX: 10, clientY: 140, timeStamp: 80 }));

    assert.equal(actions.some(entry => entry.action === INPUT.LEFT || entry.action === INPUT.RIGHT), false);
    assert.equal(actions[actions.length - 1].action, INPUT.HARD_DROP);
  });

  test('fresh downward flick with intermediate move events hard drops only on release', () => {
    touchInput._onPointerDown(pointerEvent({ clientX: 0, clientY: 0, timeStamp: 0 }));
    touchInput._onPointerMove(pointerEvent({ clientX: 5, clientY: 30, timeStamp: 20 }));
    touchInput._onPointerMove(pointerEvent({ clientX: 8, clientY: 60, timeStamp: 40 }));
    assert.deepEqual(actions.map(entry => entry.action), []);
    touchInput._onPointerUp(pointerEvent({ clientX: 10, clientY: 140, timeStamp: 80 }));

    assert.deepEqual(actions.map(entry => entry.action), [INPUT.HARD_DROP]);
  });

  test('fast fresh downward swipe does not soft-drop before release', () => {
    touchInput._onPointerDown(pointerEvent({ clientX: 0, clientY: 0, timeStamp: 0 }));
    touchInput._onPointerMove(pointerEvent({ clientX: 2, clientY: 18, timeStamp: 16 }));
    touchInput._onPointerMove(pointerEvent({ clientX: 4, clientY: 45, timeStamp: 32 }));
    touchInput._onPointerMove(pointerEvent({ clientX: 5, clientY: 78, timeStamp: 48 }));

    assert.deepEqual(actions.map(entry => entry.action), []);

    touchInput._onPointerUp(pointerEvent({ clientX: 5, clientY: 130, timeStamp: 72 }));
    assert.deepEqual(actions.map(entry => entry.action), [INPUT.HARD_DROP]);
  });

  test('horizontal drag still emits ratcheted movement', () => {
    touchInput._onPointerDown(pointerEvent({ clientX: 0, clientY: 0, timeStamp: 0 }));
    touchInput._onPointerMove(pointerEvent({ clientX: 60, clientY: 20, timeStamp: 80 }));

    assert.deepEqual(actions.map(entry => entry.action), [INPUT.RIGHT]);
  });

  test('horizontal movement keeps working after vertical drift in the same touch', () => {
    touchInput._onPointerDown(pointerEvent({ clientX: 0, clientY: 0, timeStamp: 0 }));
    touchInput._onPointerMove(pointerEvent({ clientX: 60, clientY: 10, timeStamp: 40 }));
    touchInput._onPointerMove(pointerEvent({ clientX: 50, clientY: 56, timeStamp: 80 }));
    touchInput._onPointerMove(pointerEvent({ clientX: 140, clientY: 56, timeStamp: 120 }));

    assert.deepEqual(actions.map(entry => entry.action), [INPUT.RIGHT, INPUT.RIGHT]);
  });

  test('soft drop started before horizontal movement continues during it', () => {
    touchInput._onPointerDown(pointerEvent({ clientX: 0, clientY: 0, timeStamp: 0 }));
    // Vertical dominates first → soft drop activates (dy must exceed SOFT_DROP_DEAD_ZONE=96)
    touchInput._onPointerMove(pointerEvent({ clientX: 10, clientY: 100, timeStamp: 260 }));
    // Then horizontal catches up → ratchet fires, soft drop continues
    touchInput._onPointerMove(pointerEvent({ clientX: 120, clientY: 130, timeStamp: 360 }));

    assert.deepEqual(actions.map(entry => entry.action), [
      'soft_drop',
      INPUT.RIGHT,
      INPUT.RIGHT,
    ]);
  });

  test('horizontal movement first prevents soft drop from activating', () => {
    touchInput._onPointerDown(pointerEvent({ clientX: 0, clientY: 0, timeStamp: 0 }));
    // Horizontal ratchet fires first (dx=60 > 48, dy=10 small)
    touchInput._onPointerMove(pointerEvent({ clientX: 60, clientY: 10, timeStamp: 80 }));
    // Then finger drifts down past dead zone — soft drop should NOT activate
    touchInput._onPointerMove(pointerEvent({ clientX: 60, clientY: 100, timeStamp: 300 }));

    assert.deepEqual(actions.map(entry => entry.action), [
      INPUT.RIGHT,
    ]);
  });

  test('soft_drop includes speed based on finger distance', () => {
    touchInput._onPointerDown(pointerEvent({ clientX: 0, clientY: 0, timeStamp: 0 }));
    touchInput._onPointerMove(pointerEvent({ clientX: 0, clientY: 100, timeStamp: 140 }));

    const softDropEntry = actions.find(entry => entry.action === 'soft_drop');
    assert.ok(softDropEntry, 'soft_drop action emitted');
    assert.ok(softDropEntry.data && typeof softDropEntry.data.speed === 'number', 'speed is a number');
    assert.ok(softDropEntry.data.speed >= 3 && softDropEntry.data.speed <= 10, 'speed in range 3-10');
  });

  test('fresh upward flick still triggers hold', () => {
    touchInput._onPointerDown(pointerEvent({ clientX: 0, clientY: 0, timeStamp: 0 }));
    touchInput._onPointerMove(pointerEvent({ clientX: 0, clientY: -40, timeStamp: 40 }));
    touchInput._onPointerUp(pointerEvent({ clientX: 0, clientY: -120, timeStamp: 80 }));

    assert.equal(actions[actions.length - 1].action, INPUT.HOLD);
  });

  test('fresh upward flick with intermediate move events holds only on release', () => {
    touchInput._onPointerDown(pointerEvent({ clientX: 0, clientY: 0, timeStamp: 0 }));
    touchInput._onPointerMove(pointerEvent({ clientX: -4, clientY: -30, timeStamp: 20 }));
    touchInput._onPointerMove(pointerEvent({ clientX: -6, clientY: -60, timeStamp: 40 }));
    assert.deepEqual(actions.map(entry => entry.action), []);
    touchInput._onPointerUp(pointerEvent({ clientX: -10, clientY: -140, timeStamp: 80 }));

    assert.deepEqual(actions.map(entry => entry.action), [INPUT.HOLD]);
  });

  test('release flick still fires after horizontal input', () => {
    touchInput._onPointerDown(pointerEvent({ clientX: 0, clientY: 0, timeStamp: 0 }));
    touchInput._onPointerMove(pointerEvent({ clientX: 60, clientY: 10, timeStamp: 40 }));
    // Upward flick recorded as movement before lift (pointerup coords aren't used).
    touchInput._onPointerMove(pointerEvent({ clientX: 60, clientY: -120, timeStamp: 80 }));
    touchInput._onPointerUp(pointerEvent({ clientX: 60, clientY: -120, timeStamp: 110 }));

    assert.deepEqual(actions.map(entry => entry.action), [INPUT.RIGHT, INPUT.HOLD]);
  });

  test('swipe still moving at release hard-drops even after a soft drop engaged', () => {
    touchInput._onPointerDown(pointerEvent({ clientX: 0, clientY: 0, timeStamp: 0 }));
    touchInput._onPointerMove(pointerEvent({ clientX: 0, clientY: 100, timeStamp: 140 }));
    // Finger keeps moving downward through release (80px in 40ms → moving).
    touchInput._onPointerUp(pointerEvent({ clientX: 0, clientY: 180, timeStamp: 180 }));

    assert.deepEqual(actions.map(entry => entry.action), ['soft_drop', 'soft_drop_end', INPUT.HARD_DROP]);
  });

  test('a slow moderate swipe that keeps moving hard-drops (the regression case)', () => {
    touchInput._onPointerDown(pointerEvent({ clientX: 0, clientY: 0, timeStamp: 0 }));
    touchInput._onPointerMove(pointerEvent({ clientX: 0, clientY: 60, timeStamp: 120 }));
    touchInput._onPointerMove(pointerEvent({ clientX: 0, clientY: 120, timeStamp: 240 }));
    // ~0.67 px/ms over the final segment → still moving → hard drop, not soft.
    touchInput._onPointerUp(pointerEvent({ clientX: 0, clientY: 160, timeStamp: 300 }));

    assert.equal(actions[actions.length - 1].action, INPUT.HARD_DROP);
  });

  test('down then up with no intervening move events fires nothing (no misfire)', () => {
    touchInput._onPointerDown(pointerEvent({ clientX: 0, clientY: 0, timeStamp: 0 }));
    // Jump straight to release past the tap distance with no pointermove —
    // the only sample is the pointerdown, so release velocity is unknown.
    touchInput._onPointerUp(pointerEvent({ clientX: 0, clientY: 140, timeStamp: 60 }));

    assert.deepEqual(actions.map(entry => entry.action), []);
  });

  test('downward hold (finger settled at release) stays a soft drop', () => {
    touchInput._onPointerDown(pointerEvent({ clientX: 0, clientY: 0, timeStamp: 0 }));
    touchInput._onPointerMove(pointerEvent({ clientX: 0, clientY: 150, timeStamp: 200 }));
    // Finger held still (same position) then lifted → release velocity ~0.
    touchInput._onPointerUp(pointerEvent({ clientX: 0, clientY: 150, timeStamp: 320 }));

    assert.deepEqual(actions.map(entry => entry.action), ['soft_drop', 'soft_drop_end']);
  });
});
