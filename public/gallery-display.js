'use strict';

// Scenarios that don't vary by style tier or player color.
var SCREENS = [
  { key: 'welcome',   title: 'Welcome' },
  { key: 'lobby',     title: 'Lobby' },
  { key: 'countdown', title: 'Countdown (3)' }
];

// Gameplay scenarios — shown once per style tier so normal/pillow/neon
// differences are visible side-by-side.
var TIER_SCENARIOS = [
  { key: 'playing',        title: 'Playing' },
  { key: 'line-clear',     title: 'Line clear', animated: true },
  { key: 'garbage-add',    title: 'Garbage incoming', animated: true },
  { key: 'garbage-defend', title: 'Garbage defended', animated: true },
  { key: 'ko',             title: 'All players KO', animated: true }
];

// Style tiers (see theme.js getStyleTier): level→tier mapping.
var TIERS = [
  { label: 'Normal (Lv 1)',  level: 1 },
  { label: 'Pillow (Lv 8)',  level: 8 },
  { label: 'Neon (Lv 12)',   level: 12 }
];

var OVERLAYS = [
  { key: 'pause',        title: 'Paused' },
  { key: 'reconnecting', title: 'Reconnecting' },
  { key: 'disconnected', title: 'Disconnected' },
  { key: 'results',      title: 'Results' }
];

var LEGAL = [
  { key: 'privacy', title: 'Privacy', staticPath: '/privacy' },
  { key: 'imprint', title: 'Imprint', staticPath: '/imprint' }
];

var state = Gallery.loadState();
var nonce = 0;

// Default + clamp cardsPerRow to this page's range (1..5). The controller
// page allows up to 8; when switching back, clamp so the dropdown and grid
// stay in sync.
var DISPLAY_MAX_COLS = 5;
var storedCols = parseInt(state.cardsPerRow, 10);
var clampedCols = Math.max(1, Math.min(storedCols || DISPLAY_MAX_COLS, DISPLAY_MAX_COLS));
if (clampedCols !== storedCols) {
  state.cardsPerRow = clampedCols;
  Gallery.saveState(state);
} else {
  state.cardsPerRow = clampedCols;
}

function frameClass() {
  return ({ '16x9': 'display', '21x9': 'display ar-21x9', '4x3': 'display ar-4x3', '1x1': 'display ar-1x1' })[state.displayAR] || 'display';
}
function dims() { return Gallery.DISPLAY_AR_DIMS[state.displayAR] || Gallery.DISPLAY_AR_DIMS['16x9']; }

function scenarioURL(s, levelOverride) {
  if (s.staticPath) return Gallery.staticURL(state, s.staticPath, nonce || undefined);
  var savedLevel = state.level;
  if (levelOverride !== undefined) state.level = levelOverride;
  var url = Gallery.displayURL(state, s.key, nonce || undefined);
  state.level = savedLevel;
  return url;
}

function buildRow(label, scenarios, levelOverride) {
  var row = document.createElement('div');
  row.className = 'scenario-row';

  var h = document.createElement('h3');
  var title = document.createElement('span'); title.textContent = label;
  var meta = document.createElement('span'); meta.className = 'row-meta';
  meta.textContent = scenarios.length + ' screen' + (scenarios.length === 1 ? '' : 's');
  h.appendChild(title); h.appendChild(meta);
  row.appendChild(h);

  var strip = document.createElement('div');
  strip.className = 'scenario-strip wrap';
  strip.style.setProperty('--row-cols', state.cardsPerRow);

  var cards = [];
  for (var i = 0; i < scenarios.length; i++) {
    var s = scenarios[i];
    var card = Gallery.makeCard({
      title: s.title,
      tag: s.animated ? 'anim' : (s.staticPath ? 'static' : ''),
      frameClass: frameClass(),
      logical: dims(),
      url: scenarioURL(s, levelOverride)
    });
    strip.appendChild(card);
    cards.push(card);
  }
  row.appendChild(strip);
  return { row: row, cards: cards };
}

function render() {
  Gallery.resetQueue();
  var host = document.getElementById('display-rows');
  host.innerHTML = '';

  var allCards = [];
  function add(built) {
    host.appendChild(built.row);
    allCards = allCards.concat(built.cards);
  }

  add(buildRow('Screens', SCREENS));
  for (var i = 0; i < TIERS.length; i++) {
    add(buildRow('Style · ' + TIERS[i].label, TIER_SCENARIOS, TIERS[i].level));
  }
  add(buildRow('Overlays', OVERLAYS));
  add(buildRow('Legal', LEGAL));

  Gallery.lazyMount(allCards);
}

function bindSelect(id, key, onChange, parse) {
  var el = document.getElementById(id);
  if (el && state[key] !== undefined) el.value = String(state[key]);
  el.addEventListener('change', function(e) {
    state[key] = parse ? parse(e.target.value) : e.target.value;
    Gallery.saveState(state); onChange();
  });
}
function bindNumber(id, key, min, max, onChange) {
  var el = document.getElementById(id);
  if (el) el.value = String(state[key]);
  el.addEventListener('input', function(e) {
    var v = Math.max(min, Math.min(parseInt(e.target.value, 10) || min, max));
    state[key] = v; Gallery.saveState(state); onChange();
  });
}

bindSelect('display-ar', 'displayAR', render);
bindNumber('player-count', 'players', 1, 8, render);
bindNumber('level', 'level', 1, 15, render);
bindSelect('language', 'lang', render);
bindSelect('cards-per-row', 'cardsPerRow', render, function(v) { return parseInt(v, 10) || 5; });
document.getElementById('reload-all').addEventListener('click', function() {
  nonce = Date.now(); render();
});

state.players = parseInt(state.players, 10) || 4;
state.level = parseInt(state.level, 10) || 1;
state.cardsPerRow = parseInt(state.cardsPerRow, 10) || 5;

render();
