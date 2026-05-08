// k6 load test for the Party-Sockets relay.
//
// Each k6 iteration = one room of 5 clients in active play (1 display +
// 4 controllers). Goal: find how many concurrent rooms the relay sustains
// without RTT degradation, ping loss, or app errors.
//
// The default stages sweep three plateaus (5 / 10 / 15 rooms, 8-min holds)
// to expose CPU credit-budget behaviour on shared-cpu-1x. Override STAGES
// for a different sweep.
//
// Run:
//   k6 run scripts/relay-loadtest.k6.js
//
// Common knobs (env):
//   STAGES=30s:5,8m:5,30s:10,8m:10,30s:0   stage list `dur:rooms`
//   SESSION_DURATION=300000                 ms per room before recycle
//   RELAY_URL=ws://localhost:8080           override target
//
// A sidecar VU scrapes the relay's /metrics every SCRAPE_INTERVAL seconds
// and surfaces peak clients/rooms/RSS/heap in the summary.

import { WebSocket } from 'k6/websockets';
import { setTimeout, setInterval, clearInterval, clearTimeout } from 'k6/timers';
import { Trend, Counter } from 'k6/metrics';
import http from 'k6/http';
import { sleep } from 'k6';
import exec from 'k6/execution';

const RELAY_URL           = __ENV.RELAY_URL        || 'wss://ws.hexstacker.com';
const SESSION_DURATION_MS = parseInt(__ENV.SESSION_DURATION || '300000');  // 5 min per room
const INPUT_PERIOD_MS     = parseInt(__ENV.INPUT_PERIOD     || '250');     // 4 Hz controller→display
const STATE_PERIOD_MS     = parseInt(__ENV.STATE_PERIOD     || '600');     // ~1.7 Hz display→ctrl
const STATE_BYTES         = parseInt(__ENV.STATE_BYTES      || '60');
const SCRAPE_INTERVAL_S   = parseFloat(__ENV.SCRAPE_INTERVAL || '10');
const CONTROLLERS         = 4;   // fixed: 1 display + 4 controllers = 5 clients/room

const STAGES = (__ENV.STAGES || '30s:5,8m:5,30s:10,8m:10,30s:15,8m:15,30s:0')
  .split(',').map(s => {
    const [duration, target] = s.split(':');
    return { duration, target: parseInt(target) };
  });

function parseDurationSec(d) {
  const m = String(d).match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = m[2] || 's';
  return unit === 'ms' ? n / 1000 : unit === 'm' ? n * 60 : unit === 'h' ? n * 3600 : n;
}

const TOTAL_TEST_S = STAGES.reduce((a, s) => a + parseDurationSec(s.duration), 0);

// Pre-compute stage timeline so we can tag each RTT sample with the target
// room count + phase (hold|ramp). `hold` percentiles are the meaningful ones;
// `ramp` is kept so transitions don't pollute the steady-state buckets.
const STAGE_TIMELINE = (() => {
  const out = [];
  let cursor = 0;
  let prev = 0;
  for (const { duration, target } of STAGES) {
    const dur = parseDurationSec(duration);
    out.push({ end: cursor + dur, target, phase: target === prev ? 'hold' : 'ramp' });
    cursor += dur;
    prev = target;
  }
  return out;
})();
const STAGE_TARGETS = [...new Set(STAGES.map(s => s.target))].sort((a, b) => a - b);

function currentStageTag() {
  const elapsed = (Date.now() - exec.scenario.startTime) / 1000;
  for (const p of STAGE_TIMELINE) {
    if (elapsed < p.end) return { stage: String(p.target), phase: p.phase };
  }
  return { stage: 'post', phase: 'na' };
}

// --- Metrics --------------------------------------------------------------

const rtt          = new Trend('relay_rtt_ms', true);   // tagged {stage, phase}
const joinMs       = new Trend('relay_join_ms', true);
const sent         = new Counter('relay_msgs_sent');
const recv         = new Counter('relay_msgs_recv');
const connErrors   = new Counter('relay_conn_errors');  // tagged {side}
const wsClose      = new Counter('relay_ws_close');     // tagged {side, code}
const appErrors    = new Counter('relay_app_errors');   // tagged {side}
const pingsSent    = new Counter('relay_pings_sent');
const pongsRecv    = new Counter('relay_pongs_recv');
const serverClients = new Trend('relay_server_clients');
const serverRooms   = new Trend('relay_server_rooms');
const serverRssMb   = new Trend('relay_server_rss_mb');
const serverHeapMb  = new Trend('relay_server_heap_mb');
const scrapesOk     = new Counter('relay_scrapes_ok');
const scrapeErrors  = new Counter('relay_scrape_errors');

// --- /metrics scraper sidecar --------------------------------------------

const METRICS_URL = RELAY_URL.replace(/^ws/, 'http').replace(/\?.*$/, '').replace(/\/$/, '') + '/metrics';
const SCRAPE_GAUGES = {
  'party_sockets_clients':         { trend: serverClients, scale: 1 },
  'party_sockets_rooms':           { trend: serverRooms,   scale: 1 },
  'process_resident_memory_bytes': { trend: serverRssMb,   scale: 1 / (1024 * 1024) },
  'process_heap_used_bytes':       { trend: serverHeapMb,  scale: 1 / (1024 * 1024) },
};

export function scrapeMetrics() {
  const r = http.get(METRICS_URL, { timeout: '5s', tags: { name: 'scrape' } });
  if (r.status === 200 && r.body) {
    scrapesOk.add(1);
    for (const raw of r.body.split('\n')) {
      if (!raw || raw.charCodeAt(0) === 35 /*#*/) continue;
      const m = raw.match(/^([a-zA-Z_:][\w:]*)(?:\{[^}]*\})?\s+([\d.eE+-]+)/);
      if (!m) continue;
      const target = SCRAPE_GAUGES[m[1]];
      if (!target) continue;
      const v = Number(m[2]);
      if (isFinite(v)) target.trend.add(v * target.scale);
    }
  } else {
    scrapeErrors.add(1);
  }
  sleep(SCRAPE_INTERVAL_S);
}

// --- k6 options -----------------------------------------------------------

export const options = {
  scenarios: {
    rooms: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: STAGES,
      gracefulRampDown: '5s',
      gracefulStop: '5s',
    },
    metrics_scraper: {
      executor: 'constant-vus',
      exec: 'scrapeMetrics',
      vus: 1,
      duration: `${Math.ceil(TOTAL_TEST_S)}s`,
      startTime: '0s',
      gracefulStop: '2s',
    },
  },
  summaryTrendStats: ['count', 'avg', 'min', 'med', 'max', 'p(50)', 'p(95)', 'p(99)'],
  // Pre-register {stage,phase} sub-metrics so RTT-by-stage lands in the
  // summary. Trivially-true thresholds force the stat to surface without
  // affecting pass/fail.
  thresholds: (() => {
    const t = {
      relay_app_errors: ['count==0'],
      relay_conn_errors: ['count<10'],
    };
    for (const tgt of STAGE_TARGETS) {
      for (const phase of ['hold', 'ramp']) {
        t[`relay_rtt_ms{stage:${tgt},phase:${phase}}`] = ['avg>=0'];
      }
    }
    return t;
  })(),
};

// --- Summary --------------------------------------------------------------

export function handleSummary(data) {
  const rttByStage = {};
  for (const [k, v] of Object.entries(data.metrics)) {
    if (!k.startsWith('relay_rtt_ms{') || !v?.values) continue;
    const stage = k.match(/stage:([^,}]+)/)?.[1];
    const phase = k.match(/phase:([^,}]+)/)?.[1];
    if (!stage || !phase) continue;
    rttByStage[`${stage}/${phase}`] = {
      count: v.values.count,
      p50:   v.values['p(50)'],
      p95:   v.values['p(95)'],
      p99:   v.values['p(99)'],
      max:   v.values.max,
    };
  }

  const pings = data.metrics.relay_pings_sent?.values?.count ?? 0;
  const pongs = data.metrics.relay_pongs_recv?.values?.count ?? 0;
  const lossPct = pings ? ((pings - pongs) / pings * 100) : 0;

  const peakClients = data.metrics.relay_server_clients?.values?.max ?? 0;
  const peakRooms   = data.metrics.relay_server_rooms?.values?.max ?? 0;
  const peakRss     = data.metrics.relay_server_rss_mb?.values?.max ?? 0;
  const peakHeap    = data.metrics.relay_server_heap_mb?.values?.max ?? 0;
  const scrapesOkCount = data.metrics.relay_scrapes_ok?.values?.count ?? 0;
  const appErrTotal    = data.metrics.relay_app_errors?.values?.count ?? 0;
  const connErrTotal   = data.metrics.relay_conn_errors?.values?.count ?? 0;

  const fmtRtt = (s) =>
    `count=${s.count} p50=${s.p50?.toFixed(1)} p95=${s.p95?.toFixed(1)} p99=${s.p99?.toFixed(1)} max=${s.max?.toFixed(0)}`;

  const stageRows = Object.entries(rttByStage)
    .sort(([a], [b]) => {
      const [ta, pa] = a.split('/');
      const [tb, pb] = b.split('/');
      return Number(ta) - Number(tb) || (pa === 'hold' ? -1 : 1);
    })
    .map(([k, s]) => `    ${k.padEnd(10)} ${fmtRtt(s)}`);

  const lines = [
    `\n  █ RTT BY STAGE (target rooms / phase — filter phase:hold for steady-state)`,
    ...stageRows,
    `\n  █ PING LOSS`,
    `    sent=${pings} recv=${pongs} missing=${pings - pongs} (${lossPct.toFixed(2)}%)`,
    `\n  █ RELAY STATE (peak from /metrics scrape, ${scrapesOkCount} ok)`,
    `    clients=${peakClients}  rooms=${peakRooms}  rss=${peakRss?.toFixed(0)} MB  heap=${peakHeap?.toFixed(0)} MB`,
    `\n  █ ERRORS`,
    `    app=${appErrTotal}  conn=${connErrTotal}`,
  ];

  data.rttByStage = rttByStage;
  data.pingLoss = { sent: pings, recv: pongs, missing: pings - pongs, lossPct };

  return {
    'stdout': lines.join('\n') + '\n',
    [`${__ENV.SUMMARY_EXPORT || '/tmp/k6-summary.json'}`]: JSON.stringify(data, null, 2),
  };
}

// --- Workload -------------------------------------------------------------

const STATE_PAD = 'x'.repeat(STATE_BYTES);

export default function () {
  const sid = `${__VU}-${__ITER}`;
  const displayId = `d-${sid}`;
  const ctrlIds = [];
  for (let i = 0; i < CONTROLLERS; i++) ctrlIds.push(`c-${sid}-${i}`);

  const sockets = [];
  const controllerSockets = [];
  const timers = [];
  const joinedCtrls = new Set();
  let display = null;
  let room = null;
  let instance = null;
  let playStarted = false;

  const cleanup = () => {
    timers.forEach(clearInterval);
    for (const s of sockets) {
      try {
        // Strip handlers BEFORE close so the VU doesn't wedge waiting for a
        // close-handshake callback under high load.
        s.onopen = s.onmessage = s.onerror = s.onclose = null;
        s.close();
      } catch (_) {}
    }
  };

  // Join barrier: only start sending play traffic once all 4 controllers are
  // joined. Without this, controllers' input loops fire as each one joins,
  // which means the relay sees a 2-3-client room for most of a session's
  // lifetime — the ratio we want to measure (5 clients/room) never lands.
  const startPlay = () => {
    if (playStarted) return;
    if (joinedCtrls.size < CONTROLLERS) return;
    playStarted = true;

    // Display unicasts state to a random joined controller.
    timers.push(setInterval(() => {
      if (display.readyState !== 1) return;
      const arr = [...joinedCtrls];
      const cid = arr[Math.floor(Math.random() * arr.length)];
      display.send(JSON.stringify({
        type: 'send', to: cid,
        data: { type: 'player_state', t: Date.now(), pad: STATE_PAD },
      }));
      sent.add(1);
    }, STATE_PERIOD_MS));

    // Each controller pings the display; display echoes the pong.
    for (const ws of controllerSockets) {
      timers.push(setInterval(() => {
        if (ws.readyState !== 1) return;
        ws.send(JSON.stringify({
          type: 'send', to: displayId,
          data: { type: 'lt_ping', t0: Date.now() },
        }));
        sent.add(1);
        pingsSent.add(1);
      }, INPUT_PERIOD_MS));
    }
  };

  // --- Display ---
  const dT0 = Date.now();
  display = new WebSocket(RELAY_URL);
  sockets.push(display);

  // If `created` never arrives, the iteration would otherwise hang until
  // gracefulStop kills it — masking the failure mode this test exists to find.
  const initDeadline = setTimeout(() => {
    console.warn(`[INIT_TIMEOUT] sid=${sid} no 'created' within 10s`);
    cleanup();
  }, 10_000);

  display.onopen = () => {
    display.send(JSON.stringify({
      type: 'create', clientId: displayId, maxClients: CONTROLLERS + 1,
    }));
    sent.add(1);
  };
  display.onerror = () => connErrors.add(1, { side: 'display' });
  display.onclose = (e) => wsClose.add(1, { side: 'display', code: String(e?.code ?? 'na') });
  display.onmessage = (e) => {
    recv.add(1);
    let m;
    try { m = JSON.parse(e.data); } catch (_) { return; }
    if (m && typeof m.data === 'string') {
      try { m.data = JSON.parse(m.data); } catch (_) {}
    }

    if (m.type === 'created') {
      clearTimeout(initDeadline);
      room = m.room;
      instance = m.instance || null;   // controllers pin to the same machine
      joinMs.add(Date.now() - dT0);
      setTimeout(spawnControllers, 100);
      setTimeout(cleanup, SESSION_DURATION_MS);
    } else if (m.type === 'message' && m.data?.type === 'lt_ping') {
      display.send(JSON.stringify({
        type: 'send', to: m.from,
        data: { type: 'lt_pong', t0: m.data.t0 },
      }));
      sent.add(1);
    } else if (m.type === 'error') {
      appErrors.add(1, { side: 'display' });
      console.warn(`[APP_ERROR] sid=${sid} display: ${m.message}`);
    }
  };

  // --- Controllers ---
  // Pin to the display's machine via fly-replay so we don't get "Room not
  // found" from a sibling instance.
  function spawnControllers() {
    const url = instance ? `${RELAY_URL}?instance=${encodeURIComponent(instance)}` : RELAY_URL;
    for (const cid of ctrlIds) {
      const cT0 = Date.now();
      const ws = new WebSocket(url);
      sockets.push(ws);
      controllerSockets.push(ws);

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'join', clientId: cid, room }));
        sent.add(1);
      };
      ws.onerror = () => connErrors.add(1, { side: 'controller' });
      ws.onclose = (e) => wsClose.add(1, { side: 'controller', code: String(e?.code ?? 'na') });
      ws.onmessage = (e) => {
        recv.add(1);
        let m;
        try { m = JSON.parse(e.data); } catch (_) { return; }
        if (m && typeof m.data === 'string') {
          try { m.data = JSON.parse(m.data); } catch (_) {}
        }

        if (m.type === 'joined') {
          joinMs.add(Date.now() - cT0);
          joinedCtrls.add(cid);
          startPlay();
        } else if (m.type === 'message' && m.data?.type === 'lt_pong') {
          rtt.add(Date.now() - m.data.t0, currentStageTag());
          pongsRecv.add(1);
        } else if (m.type === 'error') {
          appErrors.add(1, { side: 'controller' });
          console.warn(`[APP_ERROR] sid=${sid} ctrl=${cid}: ${m.message}`);
        }
      };
    }
  }
}
