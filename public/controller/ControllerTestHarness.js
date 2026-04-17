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
  var fakeName = params.get('name') || ['Emma','Jake','Sofia','Liam','Mia','Noah','Ava','Leo'][colorIdx];

  // Apply identity + host info that scenarios depend on.
  function applyIdentity(opts) {
    opts = opts || {};
    playerColor = PLAYER_COLORS[colorIdx];
    playerName = fakeName;
    playerCount = opts.playerCount || 4;
    isHost = !!opts.isHost;
    hostName = opts.hostName || (isHost ? playerName : 'Emma');
    hostColor = opts.hostColor || (isHost ? playerColor : PLAYER_COLORS[0]);
    if (!isNaN(levelParam)) startLevel = levelParam;
    playerNameEl.textContent = playerName;
    touchArea.setAttribute('data-player-name', playerName);
    if (nameInput) nameInput.value = playerName;
  }

  function buildFakeResults(myRank, count) {
    var ranks = [];
    var names = ['Emma','Jake','Sofia','Liam','Mia','Noah','Ava','Leo'];
    for (var i = 0; i < count; i++) {
      ranks.push({
        playerId: i === myRank - 1 ? clientId : 'debug' + i,
        playerName: i === myRank - 1 ? playerName : names[i],
        playerColor: PLAYER_COLORS[i],
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

  // --- Dispatch by scenario ---
  switch (scenario) {
    case 'name':
      // Default controller init already shows the name screen; nothing to do.
      break;

    case 'name-connecting':
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

    case 'paused':
      applyIdentity({ isHost: !!params.get('host') });
      showPlaying();
      onGamePaused();
      updateHostVisibility();
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
      // Reveal buttons immediately for the gallery snapshot.
      gameoverButtons.style.opacity = '';
      gameoverButtons.style.pointerEvents = '';
      gameoverButtonsReady = true;
      clearTimeout(gameoverButtonsTimer);
      gameoverButtonsTimer = null;
      break;
    }

    case 'results-loser': {
      var countL = Math.max(2, parseInt(params.get('players'), 10) || 3);
      applyIdentity({ isHost: false, playerCount: countL, hostName: 'Emma', hostColor: PLAYER_COLORS[0] });
      var rank = Math.min(countL, Math.max(2, parseInt(params.get('rank'), 10) || countL));
      var resultsL = buildFakeResults(rank, countL);
      lastGameResults = resultsL;
      renderGameResults(resultsL);
      showScreen('gameover');
      break;
    }

    case 'end':
      showEndScreen('game_ended', true);
      break;

    case 'end-full':
      showEndScreen('game_full', true);
      break;

    default:
      console.warn('[ControllerTestHarness] unknown scenario:', scenario);
  }
})();
