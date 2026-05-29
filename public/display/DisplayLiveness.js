'use strict';

// =====================================================================
// Display Liveness — heartbeat monitoring for display and controllers
// Depends on: DisplayState.js (globals), DisplayConnection.js (showDisconnectQR),
//             DisplayGame.js (pauseGame, checkAllPlayersDisconnected)
// =====================================================================

// Whether a peer has gone silent past the liveness window. Always false in
// AirConsole mode: there the SDK's onConnect/onDisconnect is the authoritative
// liveness signal and the relay PING that refreshes lastPingTime is dropped
// (see ControllerConnection startPing), so a present-but-idle controller must
// not be treated as gone — onPeerLeft handles real departures instead.
function peerLivenessExpired(player, now) {
  if (window.airconsole) return false;
  return !!player.lastPingTime && (now - player.lastPingTime > GameConstants.LIVENESS_TIMEOUT_MS);
}

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

    // Check if our own connection is dead (no echo back within timeout).
    // Uses SELF_HEARTBEAT_DEAD_MS, not LIVENESS_TIMEOUT_MS: with fastlane the
    // WS carries only ~1 Hz traffic, so the self-loop is the lone canary and
    // needs a wider margin than the per-controller liveness check below.
    var displayDead = heartbeatSent && (now - lastHeartbeatEcho > GameConstants.SELF_HEARTBEAT_DEAD_MS);
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

    // Check individual controller liveness. peerLivenessExpired is a no-op in
    // AirConsole mode, so the SDK's onDisconnect (→ peer_left → onPeerLeft)
    // becomes the only disconnect trigger there.
    var newDisconnect = false;
    for (const entry of players) {
      const id = entry[0];
      const player = entry[1];
      if (peerLivenessExpired(player, now)) {
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
