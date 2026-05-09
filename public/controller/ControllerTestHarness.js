'use strict';

// =====================================================================
// Controller Test Harness — scenario-driven state injection for the
// gallery page. Active only when ?scenario= is present (visual tests use
// ?test=1 alone and rely on the real connect() flow — don't stomp them).
// Loaded last so controller.js has already run its default init.
// =====================================================================

(function() {
  var params = new URLSearchParams(window.location.search);
  // Only activate when a scenario is explicitly requested. Visual tests run
  // with ?test=1 alone and still depend on the real connect() flow — don't
  // stub it out for them.
  if (!params.get('scenario')) return;

  // Gallery iframe: block outbound network so stray button clicks don't
  // hit the real relay.
  window.connect = function() {};
  // submitName is block-scoped inside controller.js; we can't override it,
  // but its only side-effect that reaches the network is connect() — already
  // stubbed above.

  var scenario = params.get('scenario');
  var colorIdx = Math.max(0, Math.min(parseInt(params.get('color'), 10) || 0, 7));
  var levelParam = parseInt(params.get('level'), 10);
  var FAKE_NAMES = ['Emma','Jake','Sofia','Liam','Mia','Noah','Ava','Leo'];
  var fakeName = params.get('name') || FAKE_NAMES[colorIdx];
  if (peerIndex == null) peerIndex = clientId;
  // Default non-host scenarios to a host at the next color slot so the
  // player's own name never collides with the host being waited for.
  var defaultHostIdx = (colorIdx + 1) % 8;

  // Apply identity + host info that scenarios depend on.
  function applyIdentity(opts) {
    opts = opts || {};
    playerColorIndex = colorIdx;
    playerColor = PLAYER_COLORS[colorIdx];
    document.body.style.setProperty('--player-color', playerColor);
    playerName = fakeName;
    playerCount = opts.playerCount || 4;
    isHost = !!opts.isHost;
    hostName = opts.hostName || (isHost ? playerName : FAKE_NAMES[defaultHostIdx]);
    hostColor = opts.hostColor || (isHost ? playerColor : PLAYER_COLORS[defaultHostIdx]);
    // Seed taken-set so the picker greys out neighbours for gallery screenshots.
    takenColorIndices = [colorIdx, defaultHostIdx];
    if (!isNaN(levelParam)) startLevel = levelParam;
    playerNameEl.textContent = playerName;
    touchArea.setAttribute('data-player-name', playerName);
    if (nameInput) nameInput.value = playerName;
  }

  function buildFakeResults(myRank, count) {
    var ranks = [];
    var names = FAKE_NAMES;
    // Pick opponent slots that skip the player's own color so we don't
    // show two entries sharing the player's identity.
    var opponentSlot = 0;
    for (var i = 0; i < count; i++) {
      var isMe = i === myRank - 1;
      var slot = isMe ? colorIdx : (opponentSlot === colorIdx ? ++opponentSlot : opponentSlot);
      if (!isMe) opponentSlot++;
      ranks.push({
        playerId: isMe ? clientId : 'debug' + i,
        playerName: isMe ? playerName : names[slot % names.length],
        colorIndex: isMe ? colorIdx : (slot % PLAYER_COLORS.length),
        rank: i + 1,
        lines: 30 - i * 3,
        level: 5 - i
      });
    }
    return ranks;
  }

  function showPlaying() {
    gameScreen.classList.remove('dead');
    gameScreen.classList.remove('paused');
    gameScreen.classList.remove('countdown');
    gameScreen.style.setProperty('--player-color', playerColor);
    pauseOverlay.classList.add('hidden');
    reconnectOverlay.classList.add('hidden');
    pauseBtn.classList.remove('hidden');
    pauseBtn.disabled = false;
    showScreen('game');
    initTouchInput();
    // Fake a ping display so layout isn't blank.
    updatePingDisplay(42);
  }

  // Restart a CSS animation on an element without reloading the iframe.
  // The removal + reflow dance is the canonical trick — simply re-setting
  // the class name doesn't retrigger an already-running animation.
  function restartAnimation(el) {
    if (!el) return;
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
  }

  // Gallery exposes a ▶ button that calls window.__TEST__.replay(); each
  // animated scenario overrides this below to re-run its own visual.
  window.__TEST__ = window.__TEST__ || {};

  // --- Dispatch by scenario ---
  switch (scenario) {
    case 'name':
      // Gallery iframes share localStorage; if a prior scenario stored a
      // clientId_<roomCode>, controller.js init takes the "reconnect"
      // branch and leaves the JOIN button disabled with "CONNECTING…".
      // Reset the name screen to its pristine first-visit state.
      nameInput.value = '';
      nameInput.disabled = false;
      nameJoinBtn.disabled = false;
      nameJoinBtn.textContent = t('join');
      break;

    case 'name-connecting':
      nameInput.value = fakeName;
      nameJoinBtn.disabled = true;
      nameJoinBtn.textContent = t('connecting');
      nameInput.disabled = true;
      break;

    case 'lobby-host':
      applyIdentity({ isHost: true, playerCount: Math.max(1, parseInt(params.get('players'), 10) || 1) });
      showLobbyUI();
      break;

    case 'lobby-waiting':
      applyIdentity({ isHost: false, playerCount: Math.max(2, parseInt(params.get('players'), 10) || 2) });
      showLobbyUI();
      break;

    case 'lobby-latejoiner':
      applyIdentity({ isHost: false, playerCount: Math.max(2, parseInt(params.get('players'), 10) || 2) });
      waitingForNextGame = true;
      showLobbyUI();
      startBtn.classList.add('hidden');
      startBtn.disabled = true;
      setWaitingActionMessage(t('game_in_progress'));
      break;

    case 'lobby-color-picker-open':
      applyIdentity({ isHost: true, playerCount: Math.max(1, parseInt(params.get('players'), 10) || 1) });
      showLobbyUI();
      // Open the rose overlay so the gallery captures its layout per
      // viewing slot (alternatives + spectrum-order assignment depend
      // on which color the player currently is).
      if (typeof openColorPicker === 'function') openColorPicker();
      break;

    case 'countdown':
      applyIdentity({ isHost: false });
      gameScreen.classList.add('countdown');
      gameScreen.style.setProperty('--player-color', playerColor);
      pauseBtn.classList.remove('hidden');
      pauseBtn.disabled = false;
      showScreen('game');
      break;

    case 'playing':
      applyIdentity({ isHost: false });
      showPlaying();
      break;

    case 'playing-settings':
      applyIdentity({ isHost: !!params.get('host') });
      showPlaying();
      // openSettings() itself calls updateSettingsHostUI, which hides/shows
      // the Music (display-mute) row based on isHost.
      window.openSettings();
      break;

    case 'paused':
      applyIdentity({ isHost: !!params.get('host') });
      showPlaying();
      onGamePaused();
      updateHostVisibility();
      window.__TEST__.replay = function() { restartAnimation(pauseButtons); };
      break;

    case 'ko':
      applyIdentity({ isHost: false });
      showPlaying();
      gameScreen.classList.add('dead');
      showKoOverlay();
      break;

    case 'reconnecting':
      applyIdentity({ isHost: false });
      showPlaying();
      reconnectOverlay.classList.remove('hidden');
      reconnectHeading.textContent = t('reconnecting');
      reconnectStatus.textContent = t('attempt_n_of_m', { attempt: 2, max: 5 });
      break;

    case 'disconnected':
      applyIdentity({ isHost: false });
      showPlaying();
      reconnectOverlay.classList.remove('hidden');
      reconnectHeading.textContent = t('disconnected');
      reconnectStatus.textContent = '';
      reconnectRejoinBtn.classList.remove('hidden');
      break;

    case 'results-winner': {
      var countW = Math.max(2, parseInt(params.get('players'), 10) || 3);
      applyIdentity({ isHost: true, playerCount: countW });
      var resultsW = buildFakeResults(1, countW);
      lastGameResults = resultsW;
      renderGameResults(resultsW);
      showScreen('gameover');
      window.__TEST__.replay = function() { restartAnimation(gameoverButtons); };
      break;
    }

    case 'results-loser': {
      var countL = Math.max(2, parseInt(params.get('players'), 10) || 3);
      applyIdentity({ isHost: false, playerCount: countL });
      // Rotate non-winner ranks (2..countL) across the 8 cards for variety.
      var defaultRank = 2 + (colorIdx % Math.max(1, countL - 1));
      var rank = Math.min(countL, Math.max(2, parseInt(params.get('rank'), 10) || defaultRank));
      var resultsL = buildFakeResults(rank, countL);
      lastGameResults = resultsL;
      renderGameResults(resultsL);
      showScreen('gameover');
      break;
    }

    case 'adclip': {
      applyIdentity({ isHost: false, playerCount: Math.max(1, parseInt(params.get('players'), 10) || 4) });
      showPlaying();
      // Hide the bottom-bar ping label, top-bar settings/pause icons, and
      // the gesture hint strip — the composite framing wants a clean
      // touchpad for the feedback to read.
      ['settings-btn', 'pause-btn', 'ping-display', 'gesture-hints', 'game-bottom-bar'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.style.display = 'none';
      });
      // Tighten the controller layout for the phone-frame shape: a small
      // top breathing room above the player name, slimmer horizontal
      // padding, and hide the TOUCHPAD watermark label.
      var adclipStyle = document.createElement('style');
      adclipStyle.textContent = [
        '#game-top-bar { padding: 18px 14px 8px !important; }',
        '#touch-area { padding: 8px 10px 14px !important; }',
        '.game-name-label { font-size: 1.1rem !important; padding-left: 2px !important; }',
        '#pad-label { display: none !important; }'
      ].join('\n');
      document.head.appendChild(adclipStyle);

      // Synthetic gesture feedback for the captured clip. The real
      // TouchInput drives showGlow on pointer events; here we drive a
      // matching visual via the Web Animations API so the orchestrator
      // can fire feedback in lockstep with engine moves.
      var fbLayer = document.getElementById('feedback-layer');
      window.__TEST__.showFeedback = function(action, opts) {
        if (!fbLayer) return;
        opts = opts || {};
        var rect = fbLayer.getBoundingClientRect();
        var w = rect.width, h = rect.height;
        if (w <= 0 || h <= 0) return;

        // Swipe gestures get a longer travel proportional to the column
        // count — a 4-column move visually pulls further across the pad
        // than a 2-column move. Duration also scales so the gesture feels
        // like one continuous motion.
        if (action === 'swipeLeft' || action === 'swipeRight') {
          var count = Math.max(1, opts.count || 1);
          var travelPx = w * Math.min(0.7, 0.20 + 0.13 * count);
          var dx = action === 'swipeLeft' ? -travelPx : travelPx;
          var size = Math.min(w, h) * 0.55;
          var cx = w * 0.5 - dx * 0.5;
          var cy = h * 0.55;
          return spawnFeedback(fbLayer, playerColor, size, cx, cy, dx, 0, '', 200 + 90 * count);
        }

        var size, cx, cy, dx, dy;
        switch (action) {
          case 'moveLeft':
            size = Math.min(w, h) * 0.6; cx = w * 0.65; cy = h * 0.5; dx = -w * 0.5; dy = 0; break;
          case 'moveRight':
            size = Math.min(w, h) * 0.6; cx = w * 0.35; cy = h * 0.5; dx =  w * 0.5; dy = 0; break;
          case 'hardDrop':
            size = Math.min(w, h) * 0.7; cx = w * 0.5;  cy = h * 0.25; dx = 0; dy =  h * 0.55; break;
          case 'hold':
            size = Math.min(w, h) * 0.7; cx = w * 0.5;  cy = h * 0.75; dx = 0; dy = -h * 0.55; break;
          case 'rotateCW':
          case 'rotateCCW':
          default:
            size = Math.min(w, h) * 0.65; cx = w * 0.5; cy = h * 0.5; dx = 0; dy = 0; break;
        }
        var rotate = action === 'rotateCW' ? ' rotate(360deg)'
                   : action === 'rotateCCW' ? ' rotate(-360deg)' : '';
        spawnFeedback(fbLayer, playerColor, size, cx, cy, dx, dy, rotate, 480);
      };

      function spawnFeedback(layer, color, size, cx, cy, dx, dy, rotate, duration) {
        var dot = document.createElement('div');
        dot.className = 'feedback-glow';
        dot.style.width = size + 'px';
        dot.style.height = size + 'px';
        dot.style.background = 'radial-gradient(circle, ' + color + 'cc 0%, ' + color + '55 50%, transparent 80%)';
        dot.style.mixBlendMode = 'screen';
        var startX = cx - size / 2;
        var startY = cy - size / 2;
        dot.style.transform = 'translate(' + startX + 'px,' + startY + 'px) scale(0.5)';
        dot.style.opacity = '0';
        layer.appendChild(dot);
        var endX = startX + dx;
        var endY = startY + dy;
        var anim = dot.animate([
          { transform: 'translate(' + startX + 'px,' + startY + 'px) scale(0.5)' + rotate, opacity: 0 },
          { transform: 'translate(' + ((startX + endX) / 2) + 'px,' + ((startY + endY) / 2) + 'px) scale(1.15)' + rotate, opacity: 1, offset: 0.4 },
          { transform: 'translate(' + endX + 'px,' + endY + 'px) scale(0.85)' + rotate, opacity: 0 }
        ], { duration: duration, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' });
        anim.onfinish = function() { if (dot.parentNode) dot.remove(); };
      }

      try { window.parent.postMessage({ type: 'adclip-ready', role: 'controller', color: colorIdx }, '*'); } catch (_) {}
      break;
    }

    default:
      console.warn('[ControllerTestHarness] unknown scenario:', scenario);
  }
})();
