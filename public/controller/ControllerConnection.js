'use strict';

// =====================================================================
// Controller Connection — PartyConnection lifecycle, ping/pong
// Depends on: ControllerState.js (globals)
// Called by: controller.js (init, event handlers)
// =====================================================================

// Send the user to the display root on any unrecoverable end state.
// `?bail=<key>` carries optional context for the display's mobile
// overlay toast. `keepClientId=true` is used by the tab-replacement
// path: the newer tab is still using that localStorage entry as its
// auto-reconnect anchor, so we mustn't clear it.
function bailToWelcome(toastKey, keepClientId) {
  if (gameCancelled) return;
  gameCancelled = true;
  stopPing();
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

  // Path-routed WS so the relay can pin us to the instance the room lives on.
  var relayUrl = RELAY_URL + '/' + encodeURIComponent(roomCode)
    + (instanceId ? '?instance=' + encodeURIComponent(instanceId) : '');
  party = new PartyConnection(relayUrl, { clientId: clientId });

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
    } else if (type === 'peer_left') {
      if (msg.index === 0) {
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
    party.sendTo(0, { type: MSG.PING, t: Date.now() });
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
  if (ms < 0) {
    latencyDisplay.textContent = t('bad_connection');
    latencyDisplay.classList.add('ping-bad');
  } else {
    latencyDisplay.textContent = ms + ' ms';
    latencyDisplay.classList.add(ms < 50 ? 'ping-good' : ms < 100 ? 'ping-ok' : 'ping-bad');
  }
}

// =====================================================================
// Send Helper
// =====================================================================

// Note: mutates payload by adding .type — callers must pass a fresh object.
function sendToDisplay(type, payload) {
  if (!party) return;
  if (payload) {
    payload.type = type;
    party.sendTo(0, payload);
  } else {
    party.sendTo(0, { type: type });
  }
}

// =====================================================================
// Disconnect / Error States
// =====================================================================

function performDisconnect() {
  stopPing();
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
