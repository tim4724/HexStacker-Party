'use strict';

// =====================================================================
// Controller Connection — PartyConnection lifecycle, ping/pong
// Depends on: ControllerState.js (globals)
// Called by: controller.js (init, event handlers)
// =====================================================================

// Auto-reopen the fastlane after a watchdog teardown or any other
// channel-closed event while the WS is still alive. Without this, a
// transient WiFi blip that kills the fastlane silently leaves inputs on
// the WS for the rest of the session. Backs off exponentially up to 30 s;
// onPeerReady resets the delay so a clean reconnect doesn't carry stale
// backoff into the next failure.
var _fastlaneRetryTimer = null;
var _fastlaneRetryDelay = 0;

function scheduleFastlaneReopen() {
  if (gameCancelled) return;
  if (_fastlaneRetryTimer) return;
  _fastlaneRetryDelay = _fastlaneRetryDelay ? Math.min(_fastlaneRetryDelay * 2, 30000) : 2000;
  _fastlaneRetryTimer = setTimeout(function () {
    _fastlaneRetryTimer = null;
    if (gameCancelled || peerIndex == null || !party || !fastlane) return;
    fastlane.open(0).catch(function () {
      // open() can reject when no DataChannel established within the ICE
      // window; onPeerClosed will fire again and re-arm the next retry.
    });
  }, _fastlaneRetryDelay);
}

function cancelFastlaneReopen() {
  if (_fastlaneRetryTimer) {
    clearTimeout(_fastlaneRetryTimer);
    _fastlaneRetryTimer = null;
  }
  _fastlaneRetryDelay = 0;
}

// Send the user to the display root on any unrecoverable end state.
// `?bail=<key>` carries optional context for the display's mobile
// overlay toast. `keepClientId=true` is used by the tab-replacement
// path: the newer tab is still using that localStorage entry as its
// auto-reconnect anchor, so we mustn't clear it.
function bailToWelcome(toastKey, keepClientId) {
  if (gameCancelled) return;
  gameCancelled = true;
  stopPing();
  cancelFastlaneReopen();
  if (fastlane) { fastlane.closeAll(); fastlane = null; }
  if (party) { party.close(); party = null; }
  if (!keepClientId) {
    try { localStorage.removeItem('clientId_' + roomCode); } catch (e) { /* iframe sandbox */ }
  }
  location.replace(toastKey ? '/?bail=' + encodeURIComponent(toastKey) : '/');
}

function connect() {
  // Gallery iframes load with ?scenario=; never open a real relay socket
  // for those, even if localStorage somehow holds a stored clientId for
  // room "GALLERY". Visual tests use ?test=1 alone and still need connect().
  if (new URLSearchParams(location.search).get('scenario')) return;

  if (party) party.close();
  cancelFastlaneReopen();
  if (fastlane) { fastlane.closeAll(); fastlane = null; }

  // Path-routed WS so the relay can pin us to the instance the room lives on.
  var relayUrl = RELAY_URL + '/' + encodeURIComponent(roomCode)
    + (instanceId ? '?instance=' + encodeURIComponent(instanceId) : '');
  party = new PartyConnection(relayUrl, { clientId: clientId });

  // Open a P2P DataChannel fastlane to the display (always slot 0) for
  // latency-sensitive input messages. The signaling envelopes ride on the
  // existing PartyConnection via party.sendTo. Skipped in AirConsole mode
  // (window.airconsole is set there and PartyConnection is replaced by
  // AirConsoleAdapter, which doesn't have a WS to piggyback on).
  if (typeof PartyFastlane !== 'undefined' && !window.airconsole) {
    fastlane = new PartyFastlane({
      // First-party STUN — self-hosted on the same infra as hexstacker.com.
      // Lets WebRTC gather server-reflexive candidates so cross-network play
      // can find a route when host candidates aren't reachable (e.g. WiFi
      // client isolation). For same-LAN play, host candidates still win and
      // the STUN server sees only the initial binding request.
      iceServers: [{ urls: 'stun:stun.hexstacker.com:3478' }],
      sendSignal: function (toIdx, data) { if (party) party.sendTo(toIdx, data); },
      onInput: function (fromIdx, data) {
        // Display is always slot 0 — same gate as the WS path.
        if (fromIdx === 0) handleMessage(data);
      },
      // Sender role: emit idle heartbeats so the RTT chip stays live when
      // there are no inputs flowing (lobby, between pieces). The display
      // doesn't reciprocate — it only emits acks in response to data.
      emitIdleHeartbeat: true,
      // onRtt fires on every inbound ack, carrying smoothed one-way latency
      // (srtt/2). Reuses updateLatencyDisplay, which also handles the bolt
      // icon visibility based on fastlane.isOpen.
      onRtt: function (peerIdx, rttHalf) {
        if (peerIdx === 0) updateLatencyDisplay(Math.round(rttHalf));
      },
      // Clean reconnect → reset backoff so the next failure starts fresh.
      onPeerReady: function (peerIdx) {
        if (peerIdx === 0) cancelFastlaneReopen();
      },
      // Watchdog teardown / connection failure → schedule a reopen with
      // exponential backoff. WS path takes over for inputs in the meantime.
      onPeerClosed: function (peerIdx) {
        if (peerIdx === 0) scheduleFastlaneReopen();
      },
    });
  }

  party.onOpen = function () {
    party.join(roomCode);
  };

  party.onProtocol = function (type, msg) {
    if (type === 'joined') {
      peerIndex = msg.index;
      startPing();
      if (currentScreen !== 'game') vibrate(15);
      party.sendTo(0, {
        type: MSG.HELLO,
        name: playerName,
        autoName: !!playerNameIsAuto,
        rejoinId: legacyRejoinId,
        rejoinToken: rejoinToken
      });
      // Reopen fastlane on every (re)join — existing peer connections don't
      // survive a relay-side replacement, and the display may have rejoined
      // while we were offline so its peer state is fresh.
      if (fastlane) {
        fastlane.setSelfIndex(peerIndex);
        fastlane.closeAll();
        // Offer flows asynchronously; sendToDisplay falls back to WS until
        // the channel is open.
        fastlane.open(0).catch(function (err) {
          console.warn('[fastlane] open failed', err);
        });
      }
    } else if (type === 'peer_left') {
      if (msg.index === 0) {
        if (fastlane) fastlane.close(0);
        if (currentScreen === 'game') {
          reconnectOverlay.classList.remove('hidden');
          reconnectHeading.textContent = t('reconnecting');
          reconnectStatus.textContent = t('display_reconnecting');
          reconnectRejoinBtn.classList.add('hidden');
        }
      }
    } else if (type === 'error') {
      if (msg.message === 'Room not found') bailToWelcome('room_not_found');
      else if (msg.message === 'Room is full') bailToWelcome('game_full');
      else bailToWelcome();
    }
  };

  party.onMessage = function (from, data) {
    // Intercept RTC signaling envelopes before app dispatch.
    if (fastlane && fastlane.handleSignal(from, data)) return;
    if (from === 0) {
      handleMessage(data);
    }
  };

  party.onClose = function (attempt, maxAttempts, meta) {
    stopPing();
    if (gameCancelled) return;
    if (meta && meta.replaced) {
      // keepClientId=true: the newer tab is using clientId_<room> as its
      // auto-reconnect anchor — clearing it would orphan that session.
      bailToWelcome(undefined, true);
      return;
    }
    if (currentScreen !== 'game') return;
    clearTimeout(disconnectedTimer);

    reconnectOverlay.classList.remove('hidden');
    if (attempt === 1) reconnectHeading.textContent = t('reconnecting');
    reconnectStatus.textContent = t('attempt_n_of_m', { attempt: Math.min(attempt, maxAttempts), max: maxAttempts });
    reconnectRejoinBtn.classList.add('hidden');
    if (attempt > maxAttempts) {
      disconnectedTimer = setTimeout(function () {
        reconnectHeading.textContent = t('disconnected');
        reconnectStatus.textContent = '';
        reconnectRejoinBtn.classList.remove('hidden');
      }, 500);
    }
  };

  party.connect();
}

// =====================================================================
// Ping / Pong
// =====================================================================

function startPing() {
  stopPing();
  lastPongTime = Date.now();
  pingTimer = setInterval(function () {
    // Stays on WS — relay-liveness check, drives PONG_TIMEOUT_MS reconnect
    // and the relay status chip. Input-path RTT comes from fastlane acks
    // via the onRtt callback, not from this PING.
    sendToDisplay(MSG.PING, { t: Date.now() });
    // Show "Bad Connection" if pong is overdue, but keep pinging.
    // Actual reconnect is handled by party.onClose when WebSocket dies.
    if (Date.now() - lastPongTime > PONG_TIMEOUT_MS) {
      updateLatencyDisplay(-1);
    }
  }, PING_INTERVAL_MS);
}

function stopPing() {
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
}

function updateLatencyDisplay(ms) {
  if (!latencyDisplay) return;
  latencyDisplay.classList.remove('ping-good', 'ping-ok', 'ping-bad');
  // Toggle the fastlane bolt indicator. The icon element is added at startup
  // by ensureLatencyMarkup(); leaving it always-present in the DOM avoids
  // re-creating it on every ping tick.
  latencyDisplay.classList.toggle('latency-display--fastlane', !!(fastlane && fastlane.isOpen(0)));
  var textEl = latencyDisplay.querySelector('.latency-display__text') || latencyDisplay;
  if (ms < 0) {
    textEl.textContent = t('bad_connection');
    latencyDisplay.classList.add('ping-bad');
  } else {
    textEl.textContent = ms + ' ms';
    latencyDisplay.classList.add(ms < 50 ? 'ping-good' : ms < 100 ? 'ping-ok' : 'ping-bad');
  }
}

// =====================================================================
// Send Helper
// =====================================================================

// Latency-sensitive message types — enqueued to the fastlane's rolling-
// window send loop when the DataChannel is open, otherwise sent reliably
// over the WebSocket. PING/PONG stays on WS now (relay-liveness check);
// input-path RTT comes from fastlane acks via onRtt.
var FASTLANE_TYPES = { input: true, soft_drop: true };

// Note: mutates payload by adding .type — callers must pass a fresh object.
function sendToDisplay(type, payload) {
  if (!party) return;
  var msg = payload || {};
  msg.type = type;
  if (fastlane && FASTLANE_TYPES[type] && fastlane.enqueue(0, msg) === 'p2p') return;
  party.sendTo(0, msg);
}

// =====================================================================
// Disconnect / Error States
// =====================================================================

function performDisconnect() {
  stopPing();
  cancelFastlaneReopen();
  if (fastlane) { fastlane.closeAll(); fastlane = null; }
  if (party) {
    try { party.sendTo(0, { type: MSG.LEAVE }); } catch (_) {}
    party.close();
    party = null;
  }
  var params = new URLSearchParams(location.search);
  params.delete('rejoin');
  params.delete('claim');
  var qs = params.toString();
  history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
  legacyRejoinId = null;
  rejoinToken = null;
  try { localStorage.removeItem('clientId_' + roomCode); } catch (e) { /* iframe sandbox */ }
  playerColor = null;
  playerColorIndex = null;
  peerIndex = null;
  takenColorIndices = [];
  // Reset session-scoped pick flags. Without this, a user who picked a
  // color, bailed back to name, and rejoined would skip reclaimPreferredColor
  // (gated on !userPickedColor) and end up stuck on the display-assigned
  // default instead of their persisted favorite.
  userPickedColor = false;
  pendingColorPick = null;
  // If the picker is open when the user bails (e.g. tap "back" before the
  // 350ms backdrop-enable timer fires), the overlay would never get
  // .hidden re-applied — and on the next lobby visit openColorPicker's
  // "already open" guard would short-circuit, leaving the overlay
  // permanently visible with no way to dismiss it.
  if (typeof closeColorPicker === 'function') closeColorPicker();
  gameCancelled = false;
  // Prefill from the persisted user-typed name (localStorage is the single
  // source of truth) — not `playerName`, which may have been replaced by
  // the display's generated fallback (e.g. "HX-27").
  var storedName = '';
  try { storedName = localStorage.getItem('stacker_player_name') || ''; } catch (e) { /* iframe sandbox */ }
  playerNameIsAuto = !storedName;
  nameInput.value = storedName;
  nameJoinBtn.disabled = false;
  nameJoinBtn.textContent = t('join');
  nameInput.disabled = false;
  nameStatusText.textContent = '';
  nameStatusDetail.textContent = '';
  reconnectOverlay.classList.add('hidden');
  showScreen('name');
  nameInput.focus();
}
