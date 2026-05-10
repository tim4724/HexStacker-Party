'use strict';

// =====================================================================
// Display Liveness — heartbeat monitoring for display and controllers
// Depends on: DisplayState.js (globals), DisplayConnection.js (showDisconnectQR),
//             DisplayGame.js (pauseGame, checkAllPlayersDisconnected)
// =====================================================================

function startLivenessCheck() {
  stopLivenessCheck();
  lastHeartbeatEcho = Date.now();
  heartbeatSent = false;
  livenessInterval = setInterval(function() {
    var now = Date.now();

    // Send heartbeat echo to self via relay. Stamp the send time so the
    // echo handler in DisplayConnection.js can compute relay RTT.
    lastHeartbeatSent = now;
    party.sendTo(0, { type: '_heartbeat' });

    // Check if our own connection is dead (no echo back within timeout)
    var displayDead = heartbeatSent && (now - lastHeartbeatEcho > GameConstants.LIVENESS_TIMEOUT_MS);
    heartbeatSent = true;

    if (displayDead) {
      if (roomState === ROOM_STATE.PLAYING || roomState === ROOM_STATE.COUNTDOWN) {
        if (!paused) pauseGame();
        pauseOverlay.classList.add('hidden');
      }
      // Don't overwrite DISCONNECTED state after attempts exhausted
      if (party.reconnectAttempt >= party.maxReconnectAttempts) return;
      // Show overlay once on first dead detection; don't overwrite
      // attempt text that onClose sets on subsequent ticks
      if (reconnectOverlay.classList.contains('hidden')) {
        reconnectOverlay.classList.remove('hidden');
        reconnectHeading.textContent = t('reconnecting');
        reconnectStatus.textContent = '';
        reconnectBtn.classList.add('hidden');
      }
      // Force reconnect — subsequent ticks skip because
      // party.connected is false while the new WS is connecting
      if (party.connected) {
        party.reconnectNow();
      }
      return;
    }

    // Check individual controller liveness
    var newDisconnect = false;
    for (const entry of players) {
      const id = entry[0];
      const player = entry[1];
      if (player.lastPingTime && (now - player.lastPingTime > GameConstants.LIVENESS_TIMEOUT_MS)) {
        if (roomState !== ROOM_STATE.LOBBY && !disconnectedQRs.has(id)) {
          showDisconnectQR(id);
          newDisconnect = true;
        }
      }
    }
    if (newDisconnect) {
      checkAllPlayersDisconnected();
      // A silent heartbeat timeout can take out the host — refresh isHost
      // flags so the handoff reaches the remaining controllers. Skip when
      // everyone is gone: getHostPeerIndex() would return null and the
      // broadcast would reach no one. No-op when the lost player wasn't
      // the host.
      if (!allPlayersDisconnected()) maybeBroadcastHostChange();
    }
  }, 1000);
}

function stopLivenessCheck() {
  if (livenessInterval) {
    clearInterval(livenessInterval);
    livenessInterval = null;
  }
}
