'use strict';

function send(ws, type, data) {
  if (ws && ws.readyState === 1) { // WebSocket.OPEN = 1
    ws.send(JSON.stringify({ type, ...data }));
  }
}

module.exports = { send };
