'use strict';

// =====================================================================
// Controller Game — game screens, touch input, feedback, results
// Depends on: ControllerState.js (globals), ControllerConnection.js (sendToDisplay)
// Called by: controller.js (message handlers)
// =====================================================================

// =====================================================================
// Lobby / Welcome
// =====================================================================

function updateLevelDisplay() {
  if (levelDisplay) levelDisplay.textContent = startLevel;
  if (levelMinusBtn) levelMinusBtn.disabled = startLevel <= 1;
  if (levelPlusBtn) levelPlusBtn.disabled = startLevel >= 15;
}

// Apply host info from a WELCOME or LOBBY_UPDATE payload, then refresh any
// visible host-gated UI. Safe to call on any screen.
function applyHostInfo(data) {
  if (data.isHost !== undefined) isHost = !!data.isHost;
  if (data.hostName !== undefined) hostName = data.hostName;
  if (data.hostColorIndex !== undefined) {
    hostColor = data.hostColorIndex != null ? PLAYER_COLORS[data.hostColorIndex] : null;
  }
  updateHostVisibility();
  if (typeof updateSettingsHostUI === 'function') updateSettingsHostUI();
}

function updateHostVisibility() {
  // Lobby: host sees Start button, non-host sees waiting banner.
  // Skip when waitingForNextGame — late joiners in an active game sit on
  // the lobby screen with the "game_in_progress" banner already in place;
  // letting the host-gate overwrite it would hide that status.
  if (currentScreen === 'lobby' && !waitingForNextGame) {
    if (isHost) {
      startBtn.classList.remove('hidden');
      startBtn.disabled = false;
      setWaitingActionMessage('');
    } else {
      startBtn.classList.add('hidden');
      startBtn.disabled = true;
      renderHostBanner(waitingActionText, 'waiting_for_host_to_start', hostName || t('player'), hostColor);
      waitingActionText.classList.remove('hidden');
    }
  }
  // Results: host sees Play Again / New Game, non-host sees waiting banner.
  // The 1.5s anti-misclick delay is handled by the #gameover-buttons CSS
  // animation (pointer-events: none during the delay), so a concurrent
  // LOBBY_UPDATE mid-delay can't flip the buttons to clickable early — the
  // animation restarts whenever the element transitions from hidden to shown.
  if (currentScreen === 'gameover') {
    if (isHost) {
      gameoverStatus.textContent = '';
      gameoverStatus.style.color = '';
      gameoverButtons.classList.remove('hidden');
    } else {
      gameoverButtons.classList.add('hidden');
      renderHostBanner(gameoverStatus, 'waiting_for_host_to_continue', hostName || t('player'), hostColor);
    }
  }
  // Pause overlay: non-host can still resume, but can't return to lobby.
  if (pauseNewGameBtn) {
    pauseNewGameBtn.classList.toggle('hidden', !isHost);
  }
}

function showLobbyUI() {
  playerIdentity.style.setProperty('--player-color', playerColor);
  playerIdentityName.textContent = playerName || t('player');
  updateLevelDisplay();

  updateStartButton();
  statusText.textContent = '';
  statusDetail.textContent = '';

  showScreen('lobby');
  // Paint after showScreen so that updateHostVisibility (below) sees
  // currentScreen === 'lobby' and wires up host-gated UI. The picker
  // itself uses a fixed-size canvas buffer so it doesn't depend on
  // visibility for measurement.
  renderColorPicker();
  // Must run after showScreen so currentScreen === 'lobby' when we gate UI.
  updateHostVisibility();
}

// Fixed canvas buffer for every rose cell. Pinning these means a repaint
// (e.g. level-change re-tiering) never reassigns canvas.width — which would
// clear the buffer and re-anchor DPR, causing a one-frame flicker as the hex
// jumped by a sub-pixel. CSS width:100%/height:100% scales the buffer to
// the live button rect. Buffer is the hex stamp's natural CSS-pixel size
// (height + stamp padding, width = height / sin(60°)) multiplied by
// devicePixelRatio so the rose hexes render at native device resolution
// instead of being upscaled by the browser from a 102×88 backing store.
// DPR is captured once at module load so the buffer size stays pinned across
// repaints. paintHexCanvas applies the matching ctx.scale so drawing coords
// stay in CSS pixels.
//
// What matters here is the aspect ratio (88/102), not absolute pixels —
// the canvas element fills its parent via `width:100%; height:100%`, so
// the browser stretches the backing store to whatever live rect the
// `.rose-cell` clamp() resolves to. If that aspect ratio (which encodes
// flat-top hex geometry: height / sin(60°) plus stamp padding) ever
// changes in CSS, update these two constants to match.
var COLOR_PICKER_CANVAS_DPR = (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1;
var COLOR_PICKER_CSS_H = 88;
var COLOR_PICKER_CSS_W = 102;  // ≈ height / sin(60°) + stamp padding
var COLOR_PICKER_CANVAS_H = Math.round(COLOR_PICKER_CSS_H * COLOR_PICKER_CANVAS_DPR);
var COLOR_PICKER_CANVAS_W = Math.round(COLOR_PICKER_CSS_W * COLOR_PICKER_CANVAS_DPR);

// DOM ordering of rose cells — fixed at buildColorPicker time. Each slot
// gets a class .rose-cell--<slotId> in the same order so CSS positions
// them via class selectors (see controller.css).
var ROSE_SLOT_ORDER = ['top', 'ur', 'lr', 'bottom', 'll', 'ul', 'center'];

// Spectrum-ordered alternative slots: when alternatives are sorted by
// PLAYER_COLORS index ascending (red → magenta), assign them to slots in
// left-to-right column reading order. Result: leftmost column = first two
// alternatives, middle column = next three, rightmost column = last two.
// The player's CURRENT color is the implicit "missing" notch in the
// gradient (it's never in the rose), reinforcing the "you came from here"
// reading without needing extra UI.
//
// Length is coupled to PLAYER_COLORS.length - 1 (= 7 for the 8-color
// palette). If the palette ever grows or shrinks, regrow this array to
// match — or renderColorPicker will silently leave trailing cells with
// dataset.idx="undefined" (un-tappable, click handler bails on isNaN).
var ROSE_SPECTRUM_ASSIGNMENT = ['ul', 'll', 'top', 'center', 'bottom', 'ur', 'lr'];

// Repaint the 7 rose cells. Called every time the lobby state changes
// (level, takenColorIndices, playerColorIndex). Closes the overlay if a
// pending pick was just confirmed by the display.
function renderColorPicker() {
  if (!colorPickerEl) return;
  var tier = (typeof getStyleTier === 'function') ? getStyleTier(startLevel || 1) : STYLE_TIERS.NORMAL;

  // 1. If a pick is pending and the display has now echoed it back as
  //    the current color, close the overlay. Done BEFORE the rose render
  //    so the early-return below catches the now-hidden state and the
  //    rose contents stay frozen during the close fade-out.
  if (pendingColorPick != null && pendingColorPick === playerColorIndex) {
    pendingColorPick = null;
    if (typeof closeColorPicker === 'function') closeColorPicker();
  }

  // 2. Skip rose repaint while the overlay is hidden (closed or fading
  //    out). Repainting during the close fade would shuffle the
  //    alternatives mid-animation as the player's new color drops out of
  //    the rose — confusing right after a pick. The rose is repainted
  //    fresh on each open via openColorPicker.
  if (colorPickerOverlay && colorPickerOverlay.classList.contains('hidden')) {
    return;
  }

  // 3. Pick the 7 alternatives in spectrum order (current color excluded)
  //    and assign them to slots in left-to-right column reading order.
  var alternatives = [];
  for (var i = 0; i < PLAYER_COLORS.length; i++) {
    if (i !== playerColorIndex) alternatives.push(i);
  }
  var taken = new Set(takenColorIndices || []);
  var slotByName = {};
  var cells = colorPickerEl.children;
  for (var c = 0; c < cells.length; c++) {
    slotByName[cells[c].dataset.slot] = cells[c];
  }
  for (var s = 0; s < ROSE_SPECTRUM_ASSIGNMENT.length; s++) {
    var slot = slotByName[ROSE_SPECTRUM_ASSIGNMENT[s]];
    if (!slot) continue;
    var idx = alternatives[s];
    var isTaken = taken.has(idx);
    slot.dataset.idx = String(idx);
    slot.classList.toggle('taken', isTaken);
    // Clear the held "picked" scale-down on every visible repaint. The
    // confirmed-pick path early-returns above (overlay hidden), preserving
    // the scale through the fade-out; this clear handles fresh-open and
    // rejected-pick repaints so the cell springs back to full size.
    slot.classList.remove('picked');
    slot.setAttribute('aria-label', t('color_choose', { n: idx + 1 }));
    if (isTaken) {
      slot.setAttribute('aria-disabled', 'true');
      slot.setAttribute('tabindex', '-1');
    } else {
      slot.removeAttribute('aria-disabled');
      slot.removeAttribute('tabindex');
    }
    paintHexCanvas(slot.firstChild, tier, PLAYER_COLORS[idx], isTaken);
  }
}

// Draw a single flat-top hex stamp into a fixed-size canvas. Used for
// both the avatar (current color, never taken) and the rose cells.
// Taken cells dim the hex (via canvas globalAlpha so the X stays at full
// chroma) and overlay a diagonal X in the player's own color.
// Drawing operates in CSS-pixel coordinates: setTransform(dpr,...) maps
// 1 logical px → dpr device px so the canvas backing store (sized at
// CSS_W*DPR × CSS_H*DPR by buildColorPicker) renders at native resolution.
function paintHexCanvas(canvas, tier, color, isTaken) {
  if (!canvas || typeof getHexStamp !== 'function') return;
  var dpr = COLOR_PICKER_CANVAS_DPR;
  var w = canvas.width / dpr;   // logical CSS-pixel width
  var h = canvas.height / dpr;  // logical CSS-pixel height
  var ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  var stampSize = h - 8;
  var stamp = getHexStamp(tier, color, stampSize);
  // stamp.cssW/cssH are the stamp's logical size; the underlying buffer is
  // already DPR-scaled internally (see CanvasUtils.getHexStamp). Drawing
  // at logical size into our DPR-scaled context renders 1:1 device pixels.
  var sw = stamp.cssW != null ? stamp.cssW : stamp.width / dpr;
  var sh = stamp.cssH != null ? stamp.cssH : stamp.height / dpr;
  if (isTaken) {
    ctx.globalAlpha = 0.4;
    ctx.drawImage(stamp, (w - sw) / 2, (h - sh) / 2, sw, sh);
    ctx.globalAlpha = 1;
    var cx = w / 2, cy = h / 2;
    var arm = h * 0.22;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(2, h * 0.08);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - arm, cy - arm);
    ctx.lineTo(cx + arm, cy + arm);
    ctx.moveTo(cx + arm, cy - arm);
    ctx.lineTo(cx - arm, cy + arm);
    ctx.stroke();
  } else {
    ctx.drawImage(stamp, (w - sw) / 2, (h - sh) / 2, sw, sh);
  }
}

// Snapshot of the persisted color from the previous session. Captured at
// script load in standalone mode; in AirConsole mode the storage shim
// hydrates asynchronously after onReady, so the bootstrap re-runs the
// capture from its onLoad callback. onLobbyUpdate's persistColorIndex is
// gated on userPickedColor (see ControllerState.js), so display-driven
// assignments don't clobber the previous-session value before reclaim
// can read it.
var _previousSessionColorIndex = null;
function captureSessionColorIndex() {
  var raw = null;
  try { raw = localStorage.getItem('stacker_color_index'); } catch (e) { /* iframe sandbox */ }
  if (raw == null) return;
  var idx = parseInt(raw, 10);
  if (!isNaN(idx) && idx >= 0 && idx < PLAYER_COLORS.length) {
    _previousSessionColorIndex = idx;
    // Tint the JOIN button before WELCOME arrives.
    document.body.style.setProperty('--player-color', PLAYER_COLORS[idx]);
  }
}
captureSessionColorIndex();

// Save the player's current color so a future reload can reclaim it.
// Called from onLobbyUpdate when userPickedColor is true (i.e. the user
// actually tapped a swatch — display-assigned defaults are ignored).
function persistColorIndex(idx) {
  try { localStorage.setItem('stacker_color_index', String(idx)); }
  catch (e) { /* iframe sandbox */ }
  // Keep the in-memory snapshot in sync with localStorage. Without this,
  // a user who picks a new color and then bails back to the name screen
  // would rejoin with reclaim still chasing the script-load value (the
  // color they had BEFORE this in-session pick).
  _previousSessionColorIndex = idx;
}

// If the previous session's color differs from what the display just
// assigned, ask for it back. Same-index is a no-op on the display side;
// collisions are silently rejected. Skip the round-trip when our preferred
// color is already taken (takenColorIndices is set from the same WELCOME
// just before this fires).
function reclaimPreferredColor() {
  if (_previousSessionColorIndex == null) return;
  if (_previousSessionColorIndex === playerColorIndex) return;
  if (typeof sendToDisplay !== 'function' || playerColorIndex == null) return;
  if (takenColorIndices && takenColorIndices.indexOf(_previousSessionColorIndex) >= 0) return;
  // Don't override an in-flight user pick: if the user has tapped a
  // swatch since this session started, that's their preference now —
  // the previous-session value is moot. Narrow race where reclaim from
  // onLoad could otherwise undo a tap that landed before hydration.
  if (userPickedColor) return;
  sendToDisplay(MSG.SET_COLOR, { colorIndex: _previousSessionColorIndex });
}

// One-time setup — sizes the avatar canvas and creates 7 rose cells. The
// cells are placed in DOM in ROSE_SLOT_ORDER (top, ur, lr, bottom, ll, ul,
// center); CSS positions them via .rose-cell--<slot> classes. Per-cell
// PLAYER_COLORS index + ARIA labels are populated on each render based on
// who the player currently is (alternatives = all 8 minus current). Click
// delegation happens at the rose container.
function buildColorPicker() {
  if (!colorPickerEl || colorPickerEl.children.length) return;
  for (var s = 0; s < ROSE_SLOT_ORDER.length; s++) {
    var slot = ROSE_SLOT_ORDER[s];
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rose-cell rose-cell--' + slot;
    btn.dataset.slot = slot;
    var canvas = document.createElement('canvas');
    canvas.width = COLOR_PICKER_CANVAS_W;
    canvas.height = COLOR_PICKER_CANVAS_H;
    btn.appendChild(canvas);
    // Hex-clipped hit overlay — see .rose-cell in controller.css for the
    // rationale (rectangular buttons would steal slanted-edge clicks from
    // tessellated neighbours).
    var hit = document.createElement('span');
    hit.className = 'rose-cell__hit';
    btn.appendChild(hit);
    colorPickerEl.appendChild(btn);
  }
}

// =====================================================================
// Color picker overlay — open / close
// =====================================================================

// Track the element that had focus when the overlay opened so we can
// restore it on close. Without this, dismissing the overlay leaves focus
// on document.body which breaks keyboard nav.
var _pickerPreviousFocus = null;

function openColorPicker() {
  if (!colorPickerOverlay) return;
  if (!colorPickerOverlay.classList.contains('hidden')) return;
  _pickerPreviousFocus = document.activeElement;
  // Drop .hidden BEFORE renderColorPicker so the rose-repaint guard inside
  // renderColorPicker (skip while .hidden) sees the open state and paints
  // the cells with the current alternatives. Synchronous canvas paints
  // complete before the fade-in transition's first frame.
  colorPickerOverlay.classList.remove('hidden');
  renderColorPicker();
  if (identityTrigger) identityTrigger.setAttribute('aria-expanded', 'true');
  // Move focus to the centre cell so keyboard users land somewhere
  // meaningful. Tap-to-open users will never see the focus ring (they're
  // touching), so the visual cost is nil.
  var center = colorPickerEl && colorPickerEl.querySelector('.rose-cell--center');
  if (center) {
    try { center.focus({ preventScroll: true }); }
    catch (e) { center.focus(); }
  }
}

function closeColorPicker() {
  if (!colorPickerOverlay) return;
  if (colorPickerOverlay.classList.contains('hidden')) return;
  colorPickerOverlay.classList.add('hidden');
  if (identityTrigger) identityTrigger.setAttribute('aria-expanded', 'false');
  // Drop any pending pick — if the user closes manually before the
  // display has confirmed, treat the request as abandoned. The display
  // will silently no-op the SET_COLOR if it's already too late.
  pendingColorPick = null;
  if (_pickerPreviousFocus && typeof _pickerPreviousFocus.focus === 'function') {
    try { _pickerPreviousFocus.focus({ preventScroll: true }); }
    catch (e) { _pickerPreviousFocus.focus(); }
  }
  _pickerPreviousFocus = null;
}

function updateStartButton() {
  startBtn.textContent = t('start_n_players', { count: playerCount });
}

function setWaitingActionMessage(message) {
  waitingActionText.textContent = message || '';
  waitingActionText.classList.toggle('hidden', !message);
  waitingActionText.style.color = '';
}

// Render a "Waiting for {name}..." banner with only the player name colored.
// Uses DOM nodes rather than innerHTML so the untrusted name can't inject HTML.
// Everything is wrapped in a single inline span so the parent's `display: flex`
// sees only one flex item — otherwise each text node + name span becomes its
// own item and the text can't wrap naturally between words.
// Assumes each locale string has exactly one {name} placeholder. A template
// with multiple {name} occurrences would split into 3+ parts and only
// parts[0]/parts[1] would render. tests/i18n.test.js ("waiting_for_host
// banner keys contain exactly one {name}") enforces this invariant.
function renderHostBanner(element, key, name, color) {
  element.textContent = '';
  element.style.color = '';
  var wrap = document.createElement('span');
  var tmpl = t(key, { name: '\x00' });
  var parts = tmpl.split('\x00');
  var nameSpan = document.createElement('span');
  nameSpan.textContent = name;
  if (color) nameSpan.style.color = color;
  if (parts.length < 2) {
    // Graceful degrade for a malformed locale: render the template text
    // followed by a space and the name, rather than colliding them.
    console.warn('[renderHostBanner] missing {name} placeholder in locale key:', key);
    wrap.appendChild(document.createTextNode(parts[0] + ' '));
    wrap.appendChild(nameSpan);
  } else {
    wrap.appendChild(document.createTextNode(parts[0]));
    wrap.appendChild(nameSpan);
    wrap.appendChild(document.createTextNode(parts[1]));
  }
  element.appendChild(wrap);
}

// =====================================================================
// Message Handlers
// =====================================================================

function onWelcome(data) {
  if (data.colorIndex != null) {
    playerColorIndex = data.colorIndex;
    playerColor = PLAYER_COLORS[data.colorIndex] || PLAYER_COLORS[0];
    // Don't persist the display-assigned color here — it's not a user
    // choice. Persisting it would clobber the previous-session preference
    // before reclaimPreferredColor gets a chance to read it. The user's
    // explicit picks are persisted in onLobbyUpdate (display echoes the
    // accepted SET_COLOR back), which is the only signal that a colorIndex
    // is actually the user's selection.
  } else {
    // Defensive: the display always sends colorIndex, but if it's missing
    // keep whatever we already have. Only seed a default when nothing is
    // set — and seed both pieces so the picker still finds a selected
    // swatch on the next render.
    if (playerColorIndex == null) playerColorIndex = 0;
    if (!playerColor) playerColor = PLAYER_COLORS[0];
  }
  if (Array.isArray(data.takenColorIndices)) takenColorIndices = data.takenColorIndices;
  // Mirror the three setProperty targets in onLobbyUpdate. WELCOME's
  // colorIndex is the same value the controller already had (the display
  // doesn't reassign on reconnect), so this is symmetry/defensiveness
  // rather than a fix for an observed flash.
  document.body.style.setProperty('--player-color', playerColor);
  playerIdentity.style.setProperty('--player-color', playerColor);
  gameScreen.style.setProperty('--player-color', playerColor);
  playerCount = data.playerCount || 1;
  gameCancelled = false;
  waitingForNextGame = false;
  // Try to reclaim the user's preferred color (saved on prior swatch
  // taps). The display rejects same-idx as a no-op and silently rejects
  // collisions, so this is safe to fire on every WELCOME — the next
  // LOBBY_UPDATE settles the truth either way.
  reclaimPreferredColor();
  // Sync the display's mute state so a reconnecting / newly-promoted host
  // sees the correct Game Music toggle without waiting for the next
  // DISPLAY_MUTED broadcast.
  if (typeof data.displayMuted === 'boolean' && typeof onDisplayMuted === 'function') {
    onDisplayMuted({ muted: data.displayMuted });
  }
  // Set host state first so renderGameResults / showLobbyUI below see it.
  // updateHostVisibility is a no-op on the current screen ('name' or mid-
  // transition) thanks to its screen guards.
  applyHostInfo(data);

  if (party) party.resetReconnectCount();
  startPing();
  clearTimeout(disconnectedTimer);
  reconnectOverlay.classList.add('hidden');

  playerName = data.playerName || playerName || t('player');
  playerNameEl.textContent = playerName;
  touchArea.setAttribute('data-player-name', playerName);
  if (data.startLevel != null) startLevel = data.startLevel;

  if (data.roomState === 'playing' || data.roomState === 'countdown') {
    // Late joiner (not in active game) — display omits alive field
    if (data.alive === undefined) {
      waitingForNextGame = true;
      showLobbyUI();
      startBtn.classList.add('hidden');
      startBtn.disabled = true;
      setWaitingActionMessage(t('game_in_progress'));
      return;
    }

    gameScreen.classList.remove('dead');
    gameScreen.classList.remove('paused');
    gameScreen.classList.remove('countdown');
    gameScreen.style.setProperty('--player-color', playerColor);
    removeKoOverlay();
    pauseBtn.classList.remove('hidden');
    if (data.paused) {
      onGamePaused();
    } else {
      pauseOverlay.classList.add('hidden');
    }

    if (data.alive === false) {
      gameScreen.classList.add('dead');
      showKoOverlay();
    }

    showScreen('game');
    initTouchInput();
    return;
  }

  if (data.roomState === 'results') {
    var reconnectResults = data.results || lastGameResults;
    if (reconnectResults) {
      lastGameResults = reconnectResults;
      renderGameResults(reconnectResults);
      showScreen('gameover');
      return;
    }
    // No results available (e.g. fresh controller joining mid-results) — fall through to lobby
  }

  showLobbyUI();
}

function onLobbyUpdate(data) {
  playerCount = data.playerCount;
  if (data.startLevel != null) startLevel = data.startLevel;
  if (data.colorIndex != null && data.colorIndex !== playerColorIndex) {
    playerColorIndex = data.colorIndex;
    playerColor = PLAYER_COLORS[data.colorIndex] || playerColor;
    document.body.style.setProperty('--player-color', playerColor);
    playerIdentity.style.setProperty('--player-color', playerColor);
    gameScreen.style.setProperty('--player-color', playerColor);
    // Persist only user-initiated changes (see userPickedColor decl in
    // ControllerState.js). Display-driven assignments — initial slot,
    // reconnect-default, reclaim's own SET_COLOR confirmation — must
    // not write here: in AC mode an early LOBBY_UPDATE landing before
    // the persistent-data fetch resolves would clobber the previous-
    // session preference in cache.
    if (userPickedColor) persistColorIndex(data.colorIndex);
  }
  if (Array.isArray(data.takenColorIndices)) takenColorIndices = data.takenColorIndices;
  applyHostInfo(data);
  updateStartButton();
  if (currentScreen === 'lobby') {
    updateLevelDisplay();
    renderColorPicker();
  }
}

function onGameStart() {
  ControllerAudio.tick();
  lastLines = 0;
  gameScreen.classList.remove('dead');
  gameScreen.classList.remove('paused');
  gameScreen.classList.remove('countdown');
  gameScreen.style.setProperty('--player-color', playerColor);
  removeKoOverlay();
  reconnectOverlay.classList.add('hidden');
  pauseOverlay.classList.add('hidden');
  pauseBtn.disabled = false;
  pauseBtn.classList.remove('hidden');
  touchArea.setAttribute('data-player-name', playerName);
  showScreen('game');
  initTouchInput();
}

function onPlayerState(data) {
  if (!touchInput) {
    gameScreen.classList.remove('countdown');
    pauseBtn.disabled = false;
    pauseBtn.classList.remove('hidden');
    initTouchInput();
  }
  if (data.lines !== undefined && data.lines > lastLines) {
    ControllerAudio.lineClear(data.lines - lastLines);
  }
  if (data.lines !== undefined) lastLines = data.lines;
  if (data.alive === false && !gameScreen.classList.contains('dead')) {
    gameScreen.classList.add('dead');
    showKoOverlay();
  }
}

function onGameEnd(data) {
  lastGameResults = data.results;
  // Settings popup can stay open across GAME_END; close it so the stale
  // pausedBySettings flag doesn't suppress a legitimate pause overlay in
  // the next game, and so the DONE button doesn't RESUME_GAME into a
  // display that has already transitioned to results.
  closeSettingsOverlay();
  renderGameResults(data.results);
  showScreen('gameover');
}

// =====================================================================
// Pause
// =====================================================================

var selfPausing = false;
var selfPausingTimer = null;
// Set by controller.js when settings is opened during gameplay. The PAUSE_GAME
// is really a side-effect of entering settings — the settings panel is on top
// and we don't want the pause overlay flashing behind it.
var pausedBySettings = false;

function onGamePaused() {
  gameScreen.classList.add('paused');
  pauseOverlay.classList.toggle('pause-overlay--self', selfPausing);
  selfPausing = false;
  clearTimeout(selfPausingTimer);
  if (!pausedBySettings) pauseOverlay.classList.remove('hidden');
  pauseBtn.disabled = true;
  pauseStatus.textContent = '';
  pauseButtons.classList.remove('hidden');
}

function onGameResumed() {
  gameScreen.classList.remove('paused');
  pauseOverlay.classList.add('hidden');
  pauseOverlay.classList.remove('pause-overlay--self');
  pauseBtn.disabled = false;
}

// =====================================================================
// Results
// =====================================================================

// The 1.5s anti-misclick delay and fade-in are purely CSS — see the
// `resultsButtonsEnter` animation on #gameover-buttons. pointer-events stays
// `none` until the animation fires, so stray taps before buttons are visible
// can't reach the click handlers.
function renderGameResults(results) {
  resultsList.innerHTML = '';
  gameoverStatus.textContent = '';
  gameoverStatus.style.color = '';
  if (isHost) {
    gameoverButtons.classList.remove('hidden');
  } else {
    gameoverButtons.classList.add('hidden');
    renderHostBanner(gameoverStatus, 'waiting_for_host_to_continue', hostName || t('player'), hostColor);
  }

  var winnerColor = 'rgba(255, 215, 0, 0.06)';
  if (results && results.length) {
    var winner = results.find(function(r) { return r.rank === 1; });
    if (winner) {
      var wc = PLAYER_COLORS[winner.colorIndex] || PLAYER_COLORS[0];
      winnerColor = rgbaFromHex(wc, 0.08);
    }
  }
  gameoverScreen.style.setProperty('--winner-glow', winnerColor);

  if (playerColor) {
    gameoverScreen.style.setProperty('--me-color', playerColor);
  }

  if (!results || !results.length) return;

  var sorted = results.slice().sort(function(a, b) { return a.rank - b.rank; });
  var solo = sorted.length === 1;
  for (var i = 0; i < sorted.length; i++) {
    var r = sorted[i];
    var pColor = PLAYER_COLORS[r.colorIndex] || PLAYER_COLORS[i % PLAYER_COLORS.length];

    var row = document.createElement('div');
    row.className = solo ? 'result-row' : 'result-row rank-' + r.rank;
    row.style.setProperty('--row-delay', (0.2 + i * 0.08) + 's');
    if (r.playerId === clientId) row.classList.add('is-me');

    if (!solo) {
      var rankEl = document.createElement('span');
      rankEl.className = 'result-rank';
      rankEl.textContent = String(r.rank);
      rankEl.style.color = pColor;
      row.appendChild(rankEl);
    }

    var info = document.createElement('div');
    info.className = 'result-info';

    var nameEl = document.createElement('span');
    nameEl.className = 'result-name';
    nameEl.textContent = r.playerName || t('player');
    nameEl.style.color = pColor;

    var stats = document.createElement('div');
    stats.className = 'result-stats';
    var linesSpan = document.createElement('span');
    linesSpan.textContent = t('n_lines', { count: r.lines || 0 });
    var levelSpan = document.createElement('span');
    levelSpan.textContent = t('level_n', { level: r.level || 1 });
    stats.appendChild(linesSpan);
    stats.appendChild(levelSpan);

    info.appendChild(nameEl);
    info.appendChild(stats);
    row.appendChild(info);
    resultsList.appendChild(row);
  }
}

// =====================================================================
// KO Overlay
// =====================================================================

function showKoOverlay() {
  removeKoOverlay();
  var ko = document.createElement('div');
  ko.id = 'ko-overlay';
  ko.textContent = t('ko');
  touchArea.appendChild(ko);
}

function removeKoOverlay() {
  var el = document.getElementById('ko-overlay');
  if (el) el.remove();
}

// =====================================================================
// Gesture Feedback — glow that follows finger
// =====================================================================

var GLOW_SIZE = 80;
var GLOW_OPACITY = 1;
var _feedbackRect = null;
window.addEventListener('resize', function() { _feedbackRect = null; });

function showGlow(x, y) {
  if (!glowEl) {
    glowEl = document.createElement('div');
    glowEl.className = 'feedback-glow';
    feedbackLayer.appendChild(glowEl);
  }
  if (!_feedbackRect) _feedbackRect = feedbackLayer.getBoundingClientRect();
  var lx = x - _feedbackRect.left;
  var ly = y - _feedbackRect.top;
  glowEl.style.transform = 'translate(' + (lx - GLOW_SIZE / 2) + 'px,' + (ly - GLOW_SIZE / 2) + 'px)';
  glowEl.style.opacity = GLOW_OPACITY;
}

function hideGlow() {
  if (glowEl) { glowEl.remove(); glowEl = null; }
}

function flashGlow() {
  if (glowEl) {
    var el = glowEl;
    glowEl = null;
    el.animate([{ opacity: GLOW_OPACITY }, { opacity: 0 }], { duration: 150, easing: 'ease-out' });
    setTimeout(function () { if (el.parentNode) el.remove(); }, 170);
  }
}

// =====================================================================
// Touch Input
// =====================================================================

function initTouchInput() {
  if (touchInput) {
    touchInput.destroy();
  }

  if (coordTracker) {
    touchArea.removeEventListener('pointerdown', coordTracker);
    touchArea.removeEventListener('pointermove', coordTracker);
    touchArea.removeEventListener('pointerup', coordTracker);
  }

  coordTracker = function (e) {
    lastTouchX = e.clientX;
    lastTouchY = e.clientY;
    if (e.type === 'pointerdown') {
      _feedbackRect = feedbackLayer.getBoundingClientRect();
      showGlow(e.clientX, e.clientY);
    } else if (e.type === 'pointermove') {
      showGlow(e.clientX, e.clientY);
    } else if (e.type === 'pointerup') {
      hideGlow();
    }
  };
  touchArea.addEventListener('pointerdown', coordTracker, { passive: true });
  touchArea.addEventListener('pointermove', coordTracker, { passive: true });
  touchArea.addEventListener('pointerup', coordTracker, { passive: true });

  touchInput = new TouchInput(touchArea, function (action, data) {
    // Gesture feedback
    if (action === 'rotate_cw') {
      ControllerAudio.tick();
      // Tap: flash the existing glow and fade out
      flashGlow();
    } else if (action === 'left' || action === 'right') {
      ControllerAudio.tick();
    } else if (action === 'hard_drop') {
      ControllerAudio.drop();
    } else if (action === 'hold') {
      ControllerAudio.hold();
    }

    if (action === 'soft_drop') {
      if (!softDropActive) {
        softDropActive = true;
        ControllerAudio.tick();
      }
      sendToDisplay(MSG.SOFT_DROP, { speed: data && data.speed });
    } else if (action === 'soft_drop_end') {
      softDropActive = false;
    } else {
      sendToDisplay(MSG.INPUT, { action: action });
    }
  }, null);
}
