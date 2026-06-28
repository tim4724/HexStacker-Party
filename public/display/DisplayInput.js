'use strict';

// =====================================================================
// Display Input — controller message handling and input validation
// Depends on: DisplayState.js, DisplayUI.js, DisplayConnection.js, DisplayGame.js
// =====================================================================

// Input validation: only accept known game actions (derived from protocol.js INPUT)
var VALID_ACTIONS = new Set(Object.values(INPUT));

function handleControllerMessage(fromId, msg) {
  try {
    if (!msg || !msg.type) return;

    // Any message from a controller proves it's alive
    var wasDisconnected = disconnectedQRs.has(fromId);
    disconnectedQRs.delete(fromId);
    if (wasDisconnected) flow.markReconnected(fromId);
    flow.onSeen(fromId, Date.now());

    switch (msg.type) {
      case MSG.HELLO:
        onHello(fromId, msg);
        break;
      case MSG.INPUT:
        onInput(fromId, msg);
        break;
      case MSG.SOFT_DROP:
        onSoftDrop(fromId, msg.speed);
        break;
      case MSG.SOFT_DROP_END:
        endSoftDrop(fromId);
        break;
      case MSG.START_GAME:
        startGame();
        break;
      case MSG.PLAY_AGAIN:
        playAgain();
        break;
      case MSG.RETURN_TO_LOBBY:
        returnToLobby();
        break;
      case MSG.PAUSE_GAME:
        pauseGame();
        break;
      case MSG.RESUME_GAME:
        resumeGame();
        break;
      case MSG.SET_LEVEL:
        onSetLevel(fromId, msg);
        break;
      case MSG.SET_COLOR:
        onSetColor(fromId, msg);
        break;
      case MSG.SET_NAME:
        onSetName(fromId, msg);
        break;
      case MSG.LEAVE:
        onPeerLeft(fromId);
        break;
      case MSG.SET_DISPLAY_MUTE:
        onSetDisplayMute(fromId, msg);
        break;
      case MSG.PING:
        // PING/PONG measures relay-mediated RTT (WS). Input-path RTT is
        // measured separately via fastlane acks (PartyFastlane onRtt).
        party.sendTo(fromId, { type: MSG.PONG, t: msg.t });
        break;
    }

    // Auto-resume after processing the message (e.g. after onHello sends
    // WELCOME with paused state) so the controller gets proper state sync
    // before the GAME_RESUMED broadcast.
    if (wasDisconnected && playerOrder.indexOf(fromId) >= 0) {
      // The reconnect already dropped flow's disconnect flag (markReconnected
      // above), so allParticipantsDisconnected is now false and the next
      // graceTick clears the late-joiner deadline — no explicit cancel needed.
      if (autoPaused) checkAutoResume();
    }
  } catch (err) {
    console.error('[input] Error handling message from', fromId, ':', err);
  }
}

// Strip control characters (incl. \x00) — defensive against names that would
// render weirdly in textContent or confuse downstream serialization.
// ControllerGame.js#renderHostBanner uses \x00 as a template-split sentinel;
// a \x00 in a player name would survive to the controller and reach that
// split. Every inbound name (HELLO + SET_NAME) passes through here — keep it
// the single sanitizing chokepoint.
function cleanInboundName(raw) {
  return typeof raw === 'string'
    ? raw.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 16)
    : '';
}

function onHello(fromId, msg) {
  var name = cleanInboundName(msg.name);
  var claimedReconnect = claimReconnectPeer(fromId, msg);

  // Player already registered (from peer_joined or reconnect)
  if (players.has(fromId)) {
    var existing = players.get(fromId);

    // Update name. Empty submissions and legacy P1-P8 fallbacks resolve to
    // room-unique HX names; custom names stay as entered.
    var prevName = existing.playerName;
    if (name || (msg.autoName === true && !claimedReconnect)) {
      // For the peer_joined-before-HELLO path, preserve the HX name already
      // assigned on the player's Map entry while excluding that entry from
      // collision checks.
      var requestedName = name || existing.playerName;
      existing.playerName = sanitizePlayerName(requestedName, fromId, msg.autoName === true);
    }
    // The host's name reaches other controllers only via LOBBY_UPDATE's
    // hostName, and onPeerJoined already broadcast the auto HX- fallback. When
    // the host's HELLO upgrades that to a real name (AC nickname applied after
    // the peer_joined-before-HELLO registration), their "Waiting for <host>"
    // banner is stale until we re-broadcast — maybeBroadcastHostChange only
    // fires on a host *index* change, not a host *name* change.
    var hostNameChanged = existing.playerName !== prevName
      && fromId === getHostPeerIndex();
    updatePlayerList();

    // Late joiner: registered via onPeerJoined during active game but never
    // participated. Omit alive/paused so controller shows waiting screen.
    var isLateJoiner = (roomState === ROOM_STATE.PLAYING || roomState === ROOM_STATE.COUNTDOWN)
      && playerOrder.indexOf(fromId) < 0;

    // Send welcome with current state
    var hostId = getHostPeerIndex();
    var hostPlayer = hostId != null ? players.get(hostId) : null;
    var welcomeMsg = {
      type: MSG.WELCOME,
      playerName: existing.playerName,
      colorIndex: existing.playerIndex,
      playerCount: players.size,
      roomState: roomState,
      startLevel: existing.startLevel || 1,
      isHost: fromId === hostId,
      hostName: hostPlayer ? hostPlayer.playerName : null,
      hostColorIndex: hostPlayer ? hostPlayer.playerIndex : null,
      takenColorIndices: collectTakenColorIndices(),
      displayMuted: !!muted
    };
    if (!isLateJoiner) {
      welcomeMsg.alive = lastAliveState[fromId] != null ? lastAliveState[fromId] : true;
      welcomeMsg.paused = paused;
    }
    if (roomState === ROOM_STATE.RESULTS && lastResults) {
      welcomeMsg.results = lastResults.results;
    }
    party.sendTo(fromId, welcomeMsg);

    // Refresh host info on the other controllers too.
    //
    // - Standard mode: a reconnecting ex-host reclaims their role.
    //   onPeerLeft kept hostPeerIndex pinned through the disconnect, and
    //   claimReconnectPeer rekeyed it from the old peerIndex to the new
    //   one. The temp host (oldest-joined present player who was acting
    //   via getHostPeerIndex's read-only fallback) cedes back, so the
    //   broadcast flips their Return-to-lobby button off and the original
    //   host's on.
    // - AirConsole mode: getMasterPeerIndex() takes priority in
    //   getHostPeerIndex, so the platform CAN re-elect the reconnecting
    //   player as master if they were the AC master before. The dedup
    //   sentinel inside maybeBroadcastHostChange suppresses the broadcast
    //   when nothing actually changed.
    maybeBroadcastHostChange();
    if (claimedReconnect) {
      broadcastLobbyUpdate();
      if (autoPaused) checkAutoResume();
    } else if (hostNameChanged) {
      broadcastLobbyUpdate();
    }
    return;
  }

  // New player joining
  var index = nextAvailableSlot();
  if (index < 0) {
    party.sendTo(fromId, { type: MSG.ERROR, message: 'Room is full' });
    return;
  }
  var playerName = sanitizePlayerName(name, fromId, msg.autoName === true);

  // flow.addPlayer assigns joinedAt + connected and makes the first joiner the
  // sticky host. This branch only runs if HELLO beats the relay's peer_joined
  // event; normally onPeerJoined gets here first and onHello takes the
  // reconnect path (flow.addPlayer merges fields on the existing record).
  flow.addPlayer(fromId, {
    playerName: playerName,
    playerIndex: index,
    startLevel: 1
  });
  flow.onSeen(fromId, Date.now());
  if (roomState === ROOM_STATE.LOBBY) {
    playerOrder.push(fromId);
  }

  var hostId = getHostPeerIndex();
  var hostPlayer = hostId != null ? players.get(hostId) : null;
  var welcomeMsg = {
    type: MSG.WELCOME,
    playerName: playerName,
    colorIndex: index,
    playerCount: players.size,
    roomState: roomState,
    startLevel: 1,
    isHost: fromId === hostId,
    hostName: hostPlayer ? hostPlayer.playerName : null,
    hostColorIndex: hostPlayer ? hostPlayer.playerIndex : null,
    takenColorIndices: collectTakenColorIndices(),
    displayMuted: !!muted
  };
  if (roomState === ROOM_STATE.RESULTS && lastResults) {
    welcomeMsg.results = lastResults.results;
  }
  party.sendTo(fromId, welcomeMsg);

  if (roomState === ROOM_STATE.LOBBY) {
    broadcastLobbyUpdate();
    updatePlayerList();
    updateStartButton();
  } else if (roomState === ROOM_STATE.RESULTS) {
    // A new low-slot player can become host — notify existing controllers so
    // their "Waiting for {name}" banners and Play Again buttons stay accurate.
    broadcastLobbyUpdate();
  }
}

function onInput(fromId, msg) {
  if (roomState !== ROOM_STATE.PLAYING || paused) return;
  if (!displayGame) return;
  if (!VALID_ACTIONS.has(msg.action)) return;

  // The engine owns hard-drop rate-limiting and soft-drop supersede.
  displayGame.processInput(fromId, msg.action);
}

function onSoftDrop(fromId, speed) {
  if (roomState !== ROOM_STATE.PLAYING || paused) return;
  if (!displayGame) return;

  // The engine arms its own auto-end fallback in case the explicit
  // SOFT_DROP_END is lost (PlayerBoard.softDropDeadlineMs).
  displayGame.handleSoftDropStart(fromId, speed);
}

// End a player's soft drop now: stop the accelerated fall. Driven by the
// explicit SOFT_DROP_END message (immediate on touch-up) or disconnect
// cleanup. The engine's own deadline still covers a lost SOFT_DROP_END.
function endSoftDrop(fromId) {
  if (displayGame) displayGame.handleSoftDropEnd(fromId);
}

function onSetDisplayMute(fromId, msg) {
  // Host-only: non-host controllers can't mute the shared display.
  var hostId = getHostPeerIndex();
  if (fromId !== hostId) {
    console.warn('[input] non-host SET_DISPLAY_MUTE rejected from', fromId);
    return;
  }
  if (typeof setDisplayMuted === 'function') {
    setDisplayMuted(msg.muted === true);
  }
}

function onSetLevel(fromId, msg) {
  var player = players.get(fromId);
  if (!player) return;
  var level = parseInt(msg.level, 10);
  if (isNaN(level) || level < 1 || level > 15) return;
  player.startLevel = level;
  if (roomState === ROOM_STATE.LOBBY) {
    updatePlayerList();
    // startLevel is a per-recipient field and the only thing that changed, so
    // a full fanout would re-send unchanged payloads to every other player —
    // rapid +/- taps were a main driver of the AirConsole 25 msgs/sec limit.
    // Echo only to the sender (confirms the level if their optimistic local
    // update raced a clamp or a reconnect).
    sendLobbyUpdateTo(fromId);
  }
}

// Re-claim a palette slot. Silently rejects collisions so concurrent picks
// don't spam the sender with errors; the next LOBBY_UPDATE carries the truth.
// Not state-gated: the controller's color picker is reachable only in the
// lobby, so a mid-game pick can't occur in practice — no guard needed.
function onSetColor(fromId, msg) {
  if (!players.has(fromId)) return;
  var idx = parseInt(msg.colorIndex, 10);
  if (isNaN(idx) || idx < 0 || idx >= PLAYER_COLORS.length) return;

  var player = players.get(fromId);
  if (player.playerIndex === idx) return;

  for (const entry of players) {
    if (entry[0] !== fromId && entry[1].playerIndex === idx) return;
  }

  player.playerIndex = idx;
  updatePlayerList();
  broadcastLobbyUpdate();
}

// Live rename from an already-registered controller (e.g. an AirConsole profile
// edit). Unlike SET_COLOR this is allowed in every state — including mid-game —
// because it only relabels the player and never touches game state. It's the
// lightweight counterpart to a HELLO: no WELCOME reply, so it can't trigger the
// controller's reconnect-restore path (initTouchInput teardown, screen reset)
// that a mid-game HELLO would.
function onSetName(fromId, msg) {
  if (!players.has(fromId)) return;
  var player = players.get(fromId);
  var prevName = player.playerName;
  // requestedAutoName is hardcoded false: SET_NAME always means "I have a real
  // name now". Honoring an autoName:true here would make sanitizePlayerName
  // discard the name and hand back an HX fallback — the opposite of a rename.
  // Empty/legacy names still resolve to an HX name via the !name branch.
  player.playerName = sanitizePlayerName(cleanInboundName(msg.name), fromId, false);
  if (player.playerName === prevName) return;
  updatePlayerList();
  // The host's name reaches other controllers only via LOBBY_UPDATE's hostName,
  // so refresh their "Waiting for <host>" banner when the host renames. A
  // non-host rename only affects the TV roster (updatePlayerList above), which
  // controllers don't mirror — skip the broadcast to stay under the controller
  // message-rate limit.
  if (fromId === getHostPeerIndex()) broadcastLobbyUpdate();
}

function cleanupPlayerInput(clientId) {
  endSoftDrop(clientId);
}
