'use strict';

// =====================================================================
// Display Connection — PartyConnection lifecycle, peer management, QR helpers
// Depends on: DisplayState.js (globals), DisplayGame.js (pauseGame, resumeGame, etc.)
// Called by: display.js (handleControllerMessage dispatches here)
// See also: DisplayLiveness.js (heartbeat monitoring, extracted)
// =====================================================================


function connectAndCreateRoom() {
  if (party) party.close();
  if (fastlane) { fastlane.closeAll(); fastlane = null; }

  // If we already know the instance (reconnect path), open the WS on the
  // sharded URL so the relay routes us back to the same instance. Fresh
  // creates use the bare URL — the relay picks an instance and tells us
  // which one in the `created` reply.
  var initialUrl = (lastRoomCode && lastInstance)
    ? RELAY_URL + '/' + encodeURIComponent(lastRoomCode) + '?instance=' + encodeURIComponent(lastInstance)
    : RELAY_URL;
  // The display's clientId acts as a per-slot bearer secret on reconnect.
  // 'display' is a stable string the relay matches to slot 0 across reloads.
  // It never crosses the wire to peers — peers see only numeric indices.
  party = new PartyConnection(initialUrl, { clientId: 'display' });

  // Display is always slot 0. Controllers initiate the SDP/ICE handshake on
  // join; the display only needs to auto-accept inbound offers and forward
  // received DataChannel messages to handleControllerMessage. Skipped in
  // AirConsole mode (no WS to piggyback on) or when ?fastlane=0 is set
  // (debug toggle for A/B comparison; controllers honor the same flag).
  var fastlaneEnabled = new URLSearchParams(location.search).get('fastlane') !== '0';
  if (fastlaneEnabled && typeof PartyFastlane !== 'undefined' && !window.airconsole) {
    fastlane = new PartyFastlane({
      // Symmetric ICE config with the controller (both sides need to know
      // about the same STUN server for cross-network handshakes to work).
      iceServers: [{ urls: STUN_URL }],
      selfIndex: 0,
      sendSignal: function (toIdx, data) { if (party) party.sendTo(toIdx, data); },
      onInput: function (fromIdx, data) { handleControllerMessage(fromIdx, data); },
    });
  }

  party.onOpen = function() {
    if (lastRoomCode) {
      party.join(lastRoomCode);
    } else {
      party.create(9);
    }
  };

  party.onClose = function(attempt, maxAttempts) {
    preCreatedRoom = null;
    if (currentScreen === SCREEN.WELCOME) return;
    clearTimeout(disconnectedTimer);

    if (roomState === ROOM_STATE.PLAYING || roomState === ROOM_STATE.COUNTDOWN) {
      if (!paused) pauseGame();
      pauseOverlay.classList.add('hidden');
    }

    reconnectOverlay.classList.remove('hidden');
    if (attempt === 1) reconnectHeading.textContent = t('reconnecting');
    reconnectStatus.textContent = t('attempt_n_of_m', { attempt: Math.min(attempt, maxAttempts), max: maxAttempts });
    reconnectBtn.classList.add('hidden');
    if (attempt > maxAttempts) {
      disconnectedTimer = setTimeout(function () {
        reconnectHeading.textContent = t('disconnected');
        reconnectStatus.textContent = '';
        reconnectBtn.classList.remove('hidden');
      }, 1000);
    }
  };

  party.onProtocol = function(type, msg) {
    switch (type) {
      case 'created':
        relayRegion = msg.region || null;
        updateRelayChip();
        onRoomCreated(msg.room, msg.instance);
        break;
      case 'joined':
        onDisplayRejoined(msg.room, msg.peers);
        break;
      case 'peer_joined':
        onPeerJoined(msg.index);
        break;
      case 'peer_left':
        onPeerLeft(msg.index);
        break;
      case 'master_changed':
        // AirConsole re-picked the master controller (e.g. premium upgrade).
        // Fires in any room state by design: menu-gate checks query host live
        // at message time, but controllers' isHost flags for their lobby /
        // results banners only refresh via LOBBY_UPDATE. A mid-game onPremium
        // is intentional — we always follow what getMasterPeerIndex dictates.
        maybeBroadcastHostChange();
        break;
      case 'error':
        if (msg.message === 'Room not found' || msg.message === 'Room is full') {
          console.error('Party-Server error:', msg.message);
          resetToWelcome();
        } else {
          console.warn('Party-Server:', msg.message);
        }
        break;
    }
  };

  party.onMessage = function(from, data) {
    // Intercept RTC signaling envelopes for the optional fastlane before app
    // dispatch. handleSignal returns true iff the message was an __rtc one.
    if (fastlane && fastlane.handleSignal(from, data)) return;
    if (from === 0 && data && data.type === '_heartbeat') {
      lastHeartbeatEcho = Date.now();
      if (lastHeartbeatSent) {
        var rtt = lastHeartbeatEcho - lastHeartbeatSent;
        lastRelayRtt = rtt;
        consecutiveBadRtt = (rtt > RELAY_RTT_OK_MS) ? consecutiveBadRtt + 1 : 0;
        updateRelayChip();
      }
      return;
    }
    handleControllerMessage(from, data);
  };

  party.connect();
}

// =====================================================================
// Party-Server Protocol Handlers
// =====================================================================

function onRoomCreated(partyRoomCode, instance) {
  lastInstance = instance || null;
  // Pin the WS URL so PartyConnection's auto-reconnect lands on the same
  // instance (the relay's bare endpoint would otherwise route to whichever
  // shard is currently least-loaded). The kit owns the sharded-URL shape.
  if (party && lastInstance) {
    party.pinInstance(RELAY_URL, partyRoomCode, lastInstance);
  }

  // Stash the instance in the URL fragment so it never hits the server in
  // requests/logs/CDN caches; the controller reads it from location.hash and
  // expands back to ?instance= when talking to the relay.
  var newJoinUrl = getBaseUrl() + '/' + partyRoomCode + (lastInstance ? '#' + encodeURIComponent(lastInstance) : '');

  // If still on welcome screen, cache the room for instant use later
  if (currentScreen === SCREEN.WELCOME) {
    preCreatedRoom = { roomCode: partyRoomCode, joinUrl: newJoinUrl };
    return;
  }

  applyRoomCreated(partyRoomCode, newJoinUrl);
}

var _copyTimer = null;

// Render the join URL into the two-span pill (small host + big room code).
// Called from both applyRoomCreated and onDisplayRejoined so the structure
// is preserved after a reconnect.
function renderJoinUrl(url) {
  var hostEl = joinUrlEl.querySelector('.join-url__host');
  var codeEl = joinUrlEl.querySelector('.join-url__code');
  if (hostEl && codeEl) {
    try {
      var u = new URL(url);
      // Trailing slash kept on the host span so it never wraps away from
      // the hostname onto the code line.
      hostEl.textContent = u.host + '/';
      codeEl.textContent = u.pathname.replace(/^\//, '') || url;
    } catch (e) {
      hostEl.textContent = '';
      codeEl.textContent = url;
    }
  } else {
    joinUrlEl.textContent = url;
  }
}

function applyRoomCreated(partyRoomCode, newJoinUrl) {
  roomCode = partyRoomCode;
  lastRoomCode = partyRoomCode;
  // Ensure we're in LOBBY (may already be if coming from welcome screen)
  if (roomState !== ROOM_STATE.LOBBY) setRoomState(ROOM_STATE.LOBBY);

  joinUrl = newJoinUrl;
  renderJoinUrl(joinUrl);
  // Click to copy the full join URL — handler is idempotent, attached
  // once on the first room creation.
  if (!joinUrlEl.dataset.copyBound) {
    joinUrlEl.dataset.copyBound = '1';
    joinUrlEl.setAttribute('role', 'button');
    joinUrlEl.setAttribute('tabindex', '0');
    joinUrlEl.setAttribute('aria-label', t('copy_url'));
    var showCopiedToast = function() {
      var copiedLabel = t('copied') || 'Copied';
      joinUrlEl.setAttribute('data-copied-label', copiedLabel);
      joinUrlEl.setAttribute('data-copied', '1');
      // Reflect the success state for screen readers — the ::after toast
      // is purely visual, so aria-label is the only cue they see.
      joinUrlEl.setAttribute('aria-label', copiedLabel);
      clearTimeout(_copyTimer);
      _copyTimer = setTimeout(function() {
        joinUrlEl.removeAttribute('data-copied');
        joinUrlEl.setAttribute('aria-label', t('copy_url'));
      }, 1600);
    };
    var copyToClipboard = function() {
      if (!joinUrl) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(joinUrl).then(showCopiedToast, tryExecCommandFallback);
      } else {
        tryExecCommandFallback();
      }
    };
    // Legacy fallback: offscreen textarea + execCommand('copy'). Reports
    // success via document.execCommand's return value so the toast only
    // shows when the copy actually landed.
    var tryExecCommandFallback = function() {
      var ta = document.createElement('textarea');
      ta.value = joinUrl;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (_) {}
      document.body.removeChild(ta);
      if (ok) showCopiedToast();
    };
    joinUrlEl.addEventListener('click', copyToClipboard);
    joinUrlEl.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); copyToClipboard(); }
    });
  }

  // Reset local state
  resetRoomData();
  _lastBroadcastedHostId = null;

  showScreen(SCREEN.LOBBY);
  updateStartButton();
  startLivenessCheck();

  // Generate + paint the QR synchronously so it's on screen the instant the
  // lobby is revealed — reading the canvas box inside renderQR forces the one
  // layout it needs, so there's no blank first frame. Generation is a sub-ms
  // in-browser encode, so there's nothing worth deferring.
  renderQR(qrCode, buildQRMatrix(joinUrl));
}

function onDisplayRejoined(partyRoomCode, peers) {
  // Display reconnected to existing room — resync state
  roomCode = partyRoomCode;
  lastRoomCode = partyRoomCode;

  joinUrl = getBaseUrl() + '/' + roomCode + (lastInstance ? '#' + encodeURIComponent(lastInstance) : '');
  renderJoinUrl(joinUrl);

  // Reset the master_changed dedup sentinel — on rejoin we re-push WELCOME
  // to everyone below, and any subsequent LOBBY_UPDATE / master_changed
  // should broadcast regardless of what the sentinel held pre-disconnect.
  _lastBroadcastedHostId = null;

  // Reset liveness for peers still in the room; handle missing ones.
  // peers is the relay's list of other-peer indices (excludes self, i.e. 0).
  var now = Date.now();
  var connectedSet = new Set(peers || []);
  var disconnectedIds = [];
  for (const pEntry of players) {
    if (connectedSet.has(pEntry[0])) {
      flow.onSeen(pEntry[0], now);
    } else {
      disconnectedIds.push(pEntry[0]);
    }
  }
  for (var i = 0; i < disconnectedIds.length; i++) {
    onPeerLeft(disconnectedIds[i]);
  }

  startLivenessCheck();

  // Clear reconnect overlay — connection restored
  clearTimeout(disconnectedTimer);
  party.resetReconnectCount();
  reconnectOverlay.classList.add('hidden');
  if (paused && (roomState === ROOM_STATE.PLAYING || roomState === ROOM_STATE.COUNTDOWN)) {
    // Clear any surviving countdown timers to prevent duplicates on resume
    clearCountdownTimers();
    resumeGame();
  }

  // Re-send WELCOME to all known players so controllers clear their reconnect overlay
  var hostId = getHostPeerIndex();
  var hostPlayer = hostId != null ? players.get(hostId) : null;
  var hostName = hostPlayer ? hostPlayer.playerName : null;
  var hostColorIndex = hostPlayer ? hostPlayer.playerIndex : null;
  var takenColorIndices = collectTakenColorIndices();
  for (const entry of players) {
    const id = entry[0];
    const info = entry[1];
    var isLateJoiner = (roomState === ROOM_STATE.PLAYING || roomState === ROOM_STATE.COUNTDOWN)
      && playerOrder.indexOf(id) < 0;
    var welcomeMsg = {
      type: MSG.WELCOME,
      playerName: info.playerName,
      colorIndex: info.playerIndex,
      playerCount: players.size,
      roomState: roomState,
      startLevel: info.startLevel || 1,
      isHost: id === hostId,
      hostName: hostName,
      hostColorIndex: hostColorIndex,
      takenColorIndices: takenColorIndices,
      displayMuted: !!muted
    };
    if (!isLateJoiner) {
      welcomeMsg.alive = lastAliveState[id] != null ? lastAliveState[id] : true;
      welcomeMsg.paused = paused;
    }
    // lastResults is { elapsed, results: [...] } — send the results array
    if (roomState === ROOM_STATE.RESULTS && lastResults) {
      welcomeMsg.results = lastResults.results;
    }
    party.sendTo(id, welcomeMsg);
  }

  if (roomState === ROOM_STATE.LOBBY) {
    showScreen(SCREEN.LOBBY);
    updateStartButton();
    renderQR(qrCode, buildQRMatrix(joinUrl));
  }
}

function onPeerJoined(peerIndex) {
  if (players.has(peerIndex)) return;
  if (players.size >= GameConstants.MAX_PLAYERS) return;

  var index = nextAvailableSlot();
  if (index < 0) return;

  // flow.addPlayer assigns joinedAt + connected and makes the first joiner the
  // sticky host. The game fields (name, color slot, level, ping) ride along on
  // the same record; the kit never reads them.
  flow.addPlayer(peerIndex, {
    playerName: generateAutoPlayerName(peerIndex),
    playerIndex: index,
    startLevel: 1
  });
  flow.onSeen(peerIndex, Date.now());

  // Only add to playerOrder in lobby — late joiners wait for next game.
  // playerOrder is snapshotted at game start by runGameLocally().
  if (roomState === ROOM_STATE.LOBBY) {
    playerOrder.push(peerIndex);
    updatePlayerList();
    updateStartButton();
    // Notify existing controllers that a palette slot just got claimed.
    // The subsequent HELLO from the joiner takes onHello's reconnect path
    // (player already in the Map) and does NOT broadcast, so without this
    // call the other pickers would keep showing the new player's color as
    // available until the next unrelated LOBBY_UPDATE.
    broadcastLobbyUpdate();
  }
}

function onPeerLeft(peerIndex) {
  if (fastlane) fastlane.close(peerIndex);
  if (!players.has(peerIndex)) return;

  cleanupPlayerInput(peerIndex);

  // Sticky-host handoff is owned by RoomFlow: flow.removePlayer re-elects only
  // when the player leaves in LOBBY/RESULTS. Mid-game (PLAYING/COUNTDOWN) the
  // participant stays in the roster (flagged disconnected via showDisconnectQR
  // -> flow.markDisconnected) so the slot stays pinned and a reconnect via
  // claimReconnectPeer (flow.rekey) reclaims it; flow's host fallback elects a
  // present player for any host action needed during the blip.
  if (roomState === ROOM_STATE.PLAYING || roomState === ROOM_STATE.COUNTDOWN) {
    if (playerOrder.indexOf(peerIndex) >= 0) {
      // Active game participant — keep in Map for seamless reconnect
      showDisconnectQR(peerIndex);
      checkAllPlayersDisconnected();
      // The stored host doesn't move mid-game (see comment above), but if
      // the departing player WAS the host then getHostPeerIndex's read-only
      // fallback now elects a present player as temp host. Re-broadcast so
      // their controller's pause-overlay Return-to-lobby button appears.
      // Skip when everyone is gone (nobody left to notify).
      if (!allPlayersDisconnected()) maybeBroadcastHostChange();
    } else {
      // Late joiner (never in the game) — remove silently
      flow.removePlayer(peerIndex);
      garbageIndicatorEffects.delete(peerIndex);
      garbageDefenceEffects.delete(peerIndex);
    }
  } else if (roomState === ROOM_STATE.LOBBY) {
    removeLobbyPlayer(peerIndex);
  } else if (roomState === ROOM_STATE.RESULTS) {
    flow.removePlayer(peerIndex);
    var idx = playerOrder.indexOf(peerIndex);
    if (idx !== -1) playerOrder.splice(idx, 1);
    flow.setActiveOrder(playerOrder);
    garbageIndicatorEffects.delete(peerIndex);
    garbageDefenceEffects.delete(peerIndex);
    // Return to lobby when no game participants remain (late joiners don't count)
    var hasParticipants = false;
    for (var i = 0; i < playerOrder.length; i++) {
      if (players.has(playerOrder[i])) { hasParticipants = true; break; }
    }
    if (!hasParticipants) {
      lastResults = null;
      setRoomState(ROOM_STATE.LOBBY);
      broadcastLobbyUpdate();
      party.broadcast({ type: MSG.RETURN_TO_LOBBY, playerCount: players.size });
      returnToLobbyUI();
    } else if (players.size > 0) {
      // Host may have changed — let remaining controllers refresh their
      // "waiting for host" banner on the results screen.
      broadcastLobbyUpdate();
    }
  }
}

function removeLobbyPlayer(peerIndex) {
  flow.removePlayer(peerIndex);
  playerOrder = playerOrder.filter(function(id) { return id !== peerIndex; });
  garbageIndicatorEffects.delete(peerIndex);
  garbageDefenceEffects.delete(peerIndex);
  updatePlayerList();
  updateStartButton();
  if (players.size > 0) {
    broadcastLobbyUpdate();
  } else if (party && typeof party.setState === 'function') {
    // Last lobby player left. The fanout had nobody to send to here, but the
    // retained snapshot must not keep naming a departed player (and a stale
    // host) to the next (re)joiner. Publish the now-empty roster so the relay
    // replays an accurate { hostPeerIndex: null, players: {} }.
    party.setState(buildRoomSnapshot());
  }
}

// =====================================================================
// QR Rejoin Claim Handling
// =====================================================================

function normalizePeerIndex(value) {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  var n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function rekeyMapPreservingOrder(map, oldId, newId, mutateValue) {
  if (!map || !map.has(oldId)) return;
  var next = new Map();
  for (const entry of map) {
    var key = entry[0];
    var value = entry[1];
    if (key === oldId) {
      if (mutateValue) mutateValue(value);
      next.set(newId, value);
    } else {
      next.set(key, value);
    }
  }
  map.clear();
  for (const nextEntry of next) map.set(nextEntry[0], nextEntry[1]);
}

function rekeyDisplayGamePlayer(oldId, newId) {
  if (!displayGame) return;

  rekeyMapPreservingOrder(displayGame.boards, oldId, newId, function(board) {
    board.playerId = newId;
  });

  if (Array.isArray(displayGame.playerIds)) {
    for (var i = 0; i < displayGame.playerIds.length; i++) {
      if (displayGame.playerIds[i] === oldId) displayGame.playerIds[i] = newId;
    }
  }

  // Move the hard-drop cooldown too, matching the engine's canonical
  // Game.rekeyPlayer (server/Game.js) that the native ports call — otherwise a
  // queued hard-drop right after a same-game reconnect behaves differently on
  // web vs TV.
  var cd = displayGame._hardDropCooldownMs;
  if (cd && cd.has(oldId)) { cd.set(newId, cd.get(oldId)); cd.delete(oldId); }

  var gm = displayGame.garbageManager;
  if (!gm) return;

  gm.rekeyPlayer(oldId, newId);
}

function transferMapEntry(map, oldId, newId) {
  if (!map || !map.has(oldId)) return;
  var value = map.get(oldId);
  map.delete(oldId);
  map.set(newId, value);
}

function claimReconnectPeer(fromId, msg) {
  var token = msg && msg.rejoinToken;
  var oldId = normalizePeerIndex(token);
  if (oldId == null && msg && msg.rejoinId != null) oldId = normalizePeerIndex(msg.rejoinId);
  if (oldId == null || oldId === fromId) return false;
  if (!players.has(oldId) || !disconnectedQRs.has(oldId)) return false;
  if (playerOrder.indexOf(oldId) < 0) return false;
  // An active participant can't claim another board: rekeying onto an id that
  // already owns a board would silently drop one of the two in the Map rebuild.
  // A genuine cross-device rejoin always arrives under a FRESH peer index.
  if (playerOrder.indexOf(fromId) >= 0) return false;

  cleanupPlayerInput(oldId);
  cleanupPlayerInput(fromId);

  // flow.rekey moves the kept record from oldId to fromId (dropping the
  // placeholder slot fromId got when it joined), and reclaims the sticky host
  // slot, participant order, and last-seen stamp for the returning peer. The
  // game-side arrays below (playerOrder, alive state, garbage effects, game
  // boards) are rekeyed alongside it.
  flow.rekey(oldId, fromId);
  flow.onSeen(fromId, Date.now());

  for (var i = 0; i < playerOrder.length; i++) {
    if (playerOrder[i] === oldId) playerOrder[i] = fromId;
  }

  if (lastAliveState[oldId] !== undefined) {
    lastAliveState[fromId] = lastAliveState[oldId];
    delete lastAliveState[oldId];
  }
  // Remap the cached ranking too: a claim on the RESULTS screen replays
  // lastResults in the WELCOME, and the returning controller matches its own
  // row by playerId.
  if (lastResults && Array.isArray(lastResults.results)) {
    for (var li = 0; li < lastResults.results.length; li++) {
      if (lastResults.results[li].playerId === oldId) lastResults.results[li].playerId = fromId;
    }
  }
  transferMapEntry(garbageIndicatorEffects, oldId, fromId);
  transferMapEntry(garbageDefenceEffects, oldId, fromId);
  disconnectedQRs.delete(oldId);
  disconnectedQRs.delete(fromId);
  rekeyDisplayGamePlayer(oldId, fromId);
  calculateLayout();
  return true;
}

// =====================================================================
// Lobby Update Broadcast
// =====================================================================

var _lastBroadcastedHostId = null;

// Re-broadcast LOBBY_UPDATE iff the host has changed since the last broadcast.
// Called after events that can silently reshuffle the host (peer_left during
// an active game, heartbeat-driven disconnect, AC master_changed). Skips when
// there's no one to notify so we don't churn on the last-player-leaves path.
function maybeBroadcastHostChange() {
  if (players.size === 0) return;
  if (getHostPeerIndex() === _lastBroadcastedHostId) return;
  broadcastLobbyUpdate();
}

// doBroadcastLobbyUpdate() publishes ONE retained snapshot via party.setState()
// (a single relay broadcast / one setCustomDeviceState), no longer a
// per-player LOBBY_UPDATE fanout. This throttle therefore coalesces bursty
// republishes into a single trailing snapshot rather than capping a per-player
// message rate. Bursts to absorb: host-change re-broadcasts, color picks, and
// the adapter-recreation join storm (peer_joined fires per controller in a
// tight loop); reconnect paths can also broadcast twice in one tick. 400ms
// collapses each burst to at most one leading + one trailing set_state.
var LOBBY_BROADCAST_MIN_INTERVAL_MS = 400;
var _lobbyBroadcastTimer = null;
var _lastLobbyBroadcastAt = 0;

// Throttled, leading + trailing: a call after a quiet period sends
// immediately; calls inside the interval collapse into one trailing fanout
// that reads live state at fire time, so the last state always wins.
function broadcastLobbyUpdate() {
  if (_lobbyBroadcastTimer) return;
  var elapsed = Date.now() - _lastLobbyBroadcastAt;
  if (elapsed >= LOBBY_BROADCAST_MIN_INTERVAL_MS) {
    doBroadcastLobbyUpdate();
    return;
  }
  _lobbyBroadcastTimer = setTimeout(function() {
    _lobbyBroadcastTimer = null;
    doBroadcastLobbyUpdate();
  }, LOBBY_BROADCAST_MIN_INTERVAL_MS - elapsed);
}

function doBroadcastLobbyUpdate() {
  _lastLobbyBroadcastAt = Date.now();
  _lastBroadcastedHostId = getHostPeerIndex();
  applyHostTint();
  // Publish the retained room snapshot once instead of fanning out a
  // per-recipient LOBBY_UPDATE to every player. The relay pushes it live to
  // connected controllers (sender excluded) and replays it to any (re)joining
  // peer right after `joined`, so N messages collapse to one set_state and a
  // briefly-dropped controller catches up for free. Controllers derive
  // playerCount, takenColorIndices, host name/color and their own color from
  // the roster (see the controller's onState). Per-recipient startLevel still
  // goes out targeted via sendLobbyUpdateTo on SET_LEVEL.
  if (party && typeof party.setState === 'function') {
    party.setState(buildRoomSnapshot());
  }
}

// The retained snapshot the relay replays to (re)joining controllers and pushes
// live on each update. Carries only globally-shared, broadcast-class state: the
// roster keyed by peerIndex (display-facing name + color slot) and the
// effective host. Tiny (<1 KiB for a full room), well under the relay's 16 KiB
// cap. Per-recipient fields (startLevel, alive, results, paused) are NOT here;
// they stay on the targeted WELCOME / LOBBY_UPDATE paths.
function buildRoomSnapshot() {
  var roster = {};
  for (const entry of players) {
    var p = entry[1];
    roster[entry[0]] = { name: p.playerName, color: p.playerIndex };
  }
  return { hostPeerIndex: getHostPeerIndex(), players: roster };
}

// Single-recipient LOBBY_UPDATE — same payload the fanout sends. Used directly
// for changes that only affect the sender's own per-recipient fields (e.g.
// SET_LEVEL), where a full fanout would re-send unchanged data to everyone.
function sendLobbyUpdateTo(id) {
  var player = players.get(id);
  if (!player) return;
  var hostId = getHostPeerIndex();
  var hostPlayer = hostId != null ? players.get(hostId) : null;
  party.sendTo(id, {
    type: MSG.LOBBY_UPDATE,
    playerCount: players.size,
    startLevel: player.startLevel || 1,
    isHost: id === hostId,
    hostName: hostPlayer ? hostPlayer.playerName : null,
    hostColorIndex: hostPlayer ? hostPlayer.playerIndex : null,
    colorIndex: player.playerIndex,
    takenColorIndices: collectTakenColorIndices()
  });
}

// Sorted list of playerIndex values currently claimed by any player in the
// room. Controllers use it to gray out swatches in the color picker.
function collectTakenColorIndices() {
  var out = [];
  for (const entry of players) out.push(entry[1].playerIndex);
  out.sort(function(a, b) { return a - b; });
  return out;
}

// =====================================================================
// QR Code Helpers
// =====================================================================

function getBaseUrl() {
  return baseUrlOverride || window.location.origin;
}

function fetchBaseUrl() {
  var host = window.location.hostname;
  if (host !== 'localhost' && host !== '127.0.0.1') return;

  fetch('/api/baseurl')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.baseUrl) baseUrlOverride = data.baseUrl;
    })
    .catch(function() { /* fall back to window.location.origin */ });
}

// Build the join-QR module matrix in-browser via the vendored qrcode-generator
// (EC level L, 1-module quiet zone — same shape the server used to return over
// /api/qr). Returns { size, modules } where modules[row*size+col] & 1 is a dark
// module, or null on failure so callers/renderQR degrade to a blank QR. The
// AirConsole entry overrides this to null (players join via the AC app, not a scan).
function buildQRMatrix(text) {
  try {
    var qr = qrcode(0, 'L'); // typeNumber 0 = smallest version that fits
    qr.addData(text);
    qr.make();
    var count = qr.getModuleCount();
    var quiet = 1;
    var size = count + quiet * 2;
    var modules = new Array(size * size).fill(0);
    for (var row = 0; row < count; row++) {
      for (var col = 0; col < count; col++) {
        if (qr.isDark(row, col)) modules[(row + quiet) * size + (col + quiet)] = 1;
      }
    }
    return { size: size, modules: modules };
  } catch (e) {
    return null;
  }
}

function showDisconnectQR(peerIndex) {
  disconnectedQRs.set(peerIndex, null);
  // INVARIANT: disconnectedQRs (presence flag + QR canvas, for rendering) and
  // flow's presence set must move together. Every site that adds/clears a
  // disconnect must touch BOTH — markDisconnected/markReconnected/clearDisconnected
  // here, and rekey() clears flow's flag on a cross-device claim. If they drift,
  // host election (which reads flow) skips a present player.
  flow.markDisconnected(peerIndex);
  if (!joinUrl) return;
  // Splice the claim in before the fragment so the instance hash stays intact.
  var hashIdx = joinUrl.indexOf('#');
  var base = hashIdx >= 0 ? joinUrl.slice(0, hashIdx) : joinUrl;
  var hash = hashIdx >= 0 ? joinUrl.slice(hashIdx) : '';
  var sep = base.indexOf('?') >= 0 ? '&' : '?';
  var rejoinUrl = base + sep + 'claim=' + encodeURIComponent(peerIndex) + hash;
  var qrMatrix = buildQRMatrix(rejoinUrl);
  if (!qrMatrix) {
    disconnectedQRs.set(peerIndex, null);
    return;
  }
  var offscreen = document.createElement('canvas');
  renderQR(offscreen, qrMatrix, 512);
  disconnectedQRs.set(peerIndex, offscreen);
}

// renderQR() lives in DisplayUI.js (rendering helper)
