'use strict';

const AUTO_PLAYER_NAME_RE = /^HX-([1-9][0-9]?)$/i;
// Keep in sync with DisplayState.js.
const AUTO_PLAYER_NAME_BLOCKLIST = [4, 13, 17, 69];

function getAutoPlayerNameNumber(name) {
  const match = typeof name === 'string' ? AUTO_PLAYER_NAME_RE.exec(name) : null;
  return match ? parseInt(match[1], 10) : null;
}

function generateAutoPlayerName(players, exceptPeerIndex, preferredName) {
  const taken = [];
  for (const entry of players) {
    if (entry[0] === exceptPeerIndex) continue;
    const num = getAutoPlayerNameNumber(entry[1].playerName);
    if (num != null) taken.push(num);
  }

  const preferredNum = getAutoPlayerNameNumber(preferredName);
  if (preferredNum != null
      && AUTO_PLAYER_NAME_BLOCKLIST.indexOf(preferredNum) < 0
      && taken.indexOf(preferredNum) < 0) {
    return 'HX-' + preferredNum;
  }

  // Deterministic test helper: production picks randomly from this pool.
  for (let i = 1; i <= 99; i++) {
    if (AUTO_PLAYER_NAME_BLOCKLIST.indexOf(i) < 0 && taken.indexOf(i) < 0) {
      return 'HX-' + i;
    }
  }
  return 'HX-1';
}

function sanitizePlayerName(name, players = new Map(), peerIndex, requestedAutoName) {
  if (requestedAutoName || !name || /^P[1-8]$/i.test(name)) {
    return generateAutoPlayerName(players, peerIndex, name);
  }
  return name;
}

module.exports = {
  AUTO_PLAYER_NAME_BLOCKLIST,
  generateAutoPlayerName,
  getAutoPlayerNameNumber,
  sanitizePlayerName
};
