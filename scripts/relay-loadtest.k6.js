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
//   STAGES=30s:5,8m:5,30s:10,8m:10,30s:15,8m:15,30s:0   stage list `dur:rooms`
//   SESSION_DURATION=300000                  ms per room before recycle
//   INPUT_PERIOD=250                         ms between controller→display pings
//   STATE_PERIOD=600                         ms between display→ctrl state msgs
//   STATE_BYTES=60                           padding bytes per state msg
//   SCRAPE_INTERVAL=10                       seconds between /metrics scrapes
//   FAILURE_BACKOFF=1000                     ms to drain in-flight messages
//                                            before closing sockets after a
//                                            connection failure (vs 500ms
//                                            for normal session-end teardown)
//   RELAY_URL=ws://localhost:8080            override target
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
const FAILURE_BACKOFF_MS  = parseInt(__ENV.FAILURE_BACKOFF || '1000');
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
// room count. We tag holds only and skip ramps (`ramp:1`) so transition
// samples don't pollute the steady-state buckets that answer "is N rooms OK".
const STAGE_TIMELINE = (() => {
  const out = [];
  let cursor = 0;
  let prev = 0;
  for (const { duration, target } of STAGES) {
    const dur = parseDurationSec(duration);
    out.push({ end: cursor + dur, target, ramp: target !== prev });
    cursor += dur;
    prev = target;
  }
  return out;
})();
// Drop target=0 (the ramp-down stage) — it never receives RTT samples and
// would only generate empty rows in the summary.
const STAGE_TARGETS = [...new Set(STAGES.map(s => s.target).filter(t => t > 0))]
  .sort((a, b) => a - b);

function currentStageTag() {
  const elapsed = (Date.now() - exec.scenario.startTime) / 1000;
  for (const p of STAGE_TIMELINE) {
    if (elapsed < p.end) return { stage: p.ramp ? 'ramp' : String(p.target) };
  }
  return { stage: 'post' };
}

// --- Metrics --------------------------------------------------------------

const rtt           = new Trend('relay_rtt_ms', true);          // tagged {stage}
const connErrors    = new Counter('relay_conn_errors');         // tagged {side}
const wsClose       = new Counter('relay_ws_close');            // tagged {side, code}
const appErrors     = new Counter('relay_app_errors');          // tagged {side, kind}
const targetMissing = new Counter('relay_target_missing_errors');
const roomAborts    = new Counter('relay_room_aborts');         // tagged {reason}
const pingsSent     = new Counter('relay_pings_sent');
const pongsRecv     = new Counter('relay_pongs_recv');
const pingsFailed   = new Counter('relay_pings_failed');        // tagged {reason}
const serverClients = new Trend('relay_server_clients');
const serverRooms   = new Trend('relay_server_rooms');
const serverRssMb   = new Trend('relay_server_rss_mb');
const serverHeapMb  = new Trend('relay_server_heap_mb');
const scrapesOk        = new Counter('relay_scrapes_ok');
const scrapeErrors     = new Counter('relay_scrape_errors');
// Counts distinct relay instances seen across all scrapes. Increments only
// the first time each instance appears — the total at end-of-test = number
// of distinct machines the proxy load-balanced our scrapes to.
// (A tagged counter would not work: tagged sub-metrics only appear in
// data.metrics when a threshold references them, and we don't know
// instance IDs upfront.)
const scrapeInstances  = new Counter('relay_scrape_instances');
const seenInstances    = new Set();

function appErrorKind(message) {
  // Substring match — relay error wording has drifted before
  // ('Target client' → 'Target peer'); exact match silently regressed.
  const m = (message || '').toLowerCase();
  if (m.includes('target') && m.includes('not found')) return 'target_not_found';
  if (m.includes('room')   && m.includes('not found')) return 'room_not_found';
  if (m.includes('full'))                              return 'room_full';
  return 'other';
}

function roomSocketUrl(room, instance) {
  const base = RELAY_URL.replace(/[?#].*$/, '').replace(/\/$/, '');
  const query = instance ? `?instance=${encodeURIComponent(instance)}` : '';
  return `${base}/${encodeURIComponent(room)}${query}`;
}

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
    // Each scrape lands on a single machine (proxy LB). Track distinct
    // instances so the summary can warn that gauge peaks (clients/rooms)
    // are per-machine, not totals, when load is split.
    // NB: relies on the relay exposing `instance="..."` labels. Without
    // them all scrapes are tagged 'unknown' and the count stays at 1.
    const inst = r.body.match(/instance="([^"]+)"/)?.[1] || 'unknown';
    if (!seenInstances.has(inst)) {
      seenInstances.add(inst);
      scrapeInstances.add(1);
    }
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
      // 15s — covers FAILURE_BACKOFF (1s drain) + 5 sockets closing under
      // partial relay failure. Observed wedge with 5s when machine suspended
      // mid-session; sockets needed longer to fully release.
      gracefulStop: '15s',
    },
    metrics_scraper: {
      executor: 'constant-vus',
      exec: 'scrapeMetrics',
      vus: 1,
      duration: `${Math.ceil(TOTAL_TEST_S)}s`,
      startTime: '0s',
      // 15s — scraper sleeps SCRAPE_INTERVAL_S (default 10) inside its
      // iteration; gracefulStop must exceed that or the VU is cut mid-sleep.
      gracefulStop: '15s',
    },
  },
  summaryTrendStats: ['count', 'avg', 'min', 'max', 'p(50)', 'p(95)', 'p(99)'],
  // Pre-register {stage:N} sub-metrics so RTT-by-stage lands in the summary.
  // Trivially-true thresholds force the stat to surface without affecting
  // pass/fail.
  thresholds: (() => {
    const t = {
      // A few app errors can still happen during teardown. Sustained target
      // misses are handled as room aborts now, not allowed to spam for minutes.
      // Small budget for each error category — single network blips, GC
      // pauses, or relay restarts on multi-minute sweeps shouldn't fail the
      // whole run. Sustained problems blow past these limits quickly.
      relay_app_errors: ['count<100'],
      // room_aborts is generous: this test is meant to expose credit-pressure
      // stalls. A single VM preempt or relay restart under credit exhaustion
      // can abort every open room (~5-10 at once), and we don't want to fail
      // the run at exactly the condition we want to observe.
      relay_room_aborts: ['count<20'],
      relay_target_missing_errors: ['count<5'],
      relay_conn_errors: ['count<10'],
      // /metrics scraper failures: if it can't reach the relay we'd
      // otherwise silently print clients=0 rooms=0. Cap at 10 transient
      // errors over a multi-minute test.
      relay_scrape_errors: ['count<10'],
      // Trivially-true thresholds — surface these counters in the summary
      // even on clean runs. Don't affect pass/fail.
      relay_ws_close: ['count>=0'],
      relay_pings_failed: ['count>=0'],
    };
    for (const tgt of STAGE_TARGETS) {
      t[`relay_rtt_ms{stage:${tgt}}`] = ['avg>=0'];
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
    if (!stage || stage === 'ramp' || stage === 'post') continue;
    rttByStage[stage] = {
      count: v.values.count,
      p50:   v.values['p(50)'],
      p95:   v.values['p(95)'],
      p99:   v.values['p(99)'],
      max:   v.values.max,
    };
  }

  const pings = data.metrics.relay_pings_sent?.values?.count ?? 0;
  const pongs = data.metrics.relay_pongs_recv?.values?.count ?? 0;
  const failedPings = data.metrics.relay_pings_failed?.values?.count ?? 0;
  const unresolvedPings = Math.max(0, pings - pongs - failedPings);
  const pongPct = pings ? (pongs / pings * 100) : 0;
  const failedPct = pings ? (failedPings / pings * 100) : 0;
  const unresolvedPct = pings ? (unresolvedPings / pings * 100) : 0;

  const peakClients = data.metrics.relay_server_clients?.values?.max ?? 0;
  const peakRooms   = data.metrics.relay_server_rooms?.values?.max ?? 0;
  const peakRss     = data.metrics.relay_server_rss_mb?.values?.max ?? 0;
  const peakHeap    = data.metrics.relay_server_heap_mb?.values?.max ?? 0;
  const scrapesOkCount = data.metrics.relay_scrapes_ok?.values?.count ?? 0;
  const appErrTotal    = data.metrics.relay_app_errors?.values?.count ?? 0;
  const targetMissTotal = data.metrics.relay_target_missing_errors?.values?.count ?? 0;
  const connErrTotal   = data.metrics.relay_conn_errors?.values?.count ?? 0;
  const abortTotal      = data.metrics.relay_room_aborts?.values?.count ?? 0;

  // Distinct relay instances seen via /metrics scrapes — proxy load-balances
  // each scrape to one machine, so peakClients/peakRooms are per-machine
  // when this count is > 1.
  const instCount = data.metrics.relay_scrape_instances?.values?.count ?? 0;
  const stateNote = instCount === 0
    ? 'no scrapes succeeded'
    : instCount > 1
      ? `clients/rooms are per-machine (${instCount} instances seen — load is split)`
      : 'single machine seen';

  const fmtRtt = (s) =>
    `count=${s.count} p50=${s.p50?.toFixed(1)} p95=${s.p95?.toFixed(1)} p99=${s.p99?.toFixed(1)} max=${s.max?.toFixed(0)}`;

  const stageRows = Object.entries(rttByStage)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([k, s]) => `    ${k.padStart(3)} rooms  ${fmtRtt(s)}`);

  const lines = [
    `\n  █ RTT BY STAGE (steady-state holds only)`,
    ...stageRows,
    `\n  █ PING OUTCOMES`,
    `    sent=${pings} pong=${pongs} (${pongPct.toFixed(2)}%) failed=${failedPings} (${failedPct.toFixed(2)}%) unresolved=${unresolvedPings} (${unresolvedPct.toFixed(2)}%)`,
    `\n  █ RELAY STATE (peak from /metrics scrape, ${scrapesOkCount} ok — ${stateNote})`,
    `    clients=${peakClients}  rooms=${peakRooms}  rss=${peakRss?.toFixed(0)} MB  heap=${peakHeap?.toFixed(0)} MB`,
    `\n  █ ERRORS`,
    `    app=${appErrTotal}  target_missing=${targetMissTotal}  conn=${connErrTotal}  room_aborts=${abortTotal}`,
  ];

  data.rttByStage = rttByStage;
  data.pingOutcomes = {
    sent: pings,
    pong: pongs,
    failed: failedPings,
    unresolved: unresolvedPings,
    pongPct,
    failedPct,
    unresolvedPct,
  };
  data.relayInstancesSeen = instCount;

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
  const joinedCtrlIndices = new Set();
  let display = null;
  let displayIndex = null;
  let room = null;
  let instance = null;
  let playStarted = false;
  let cleaningUp = false;
  let initDeadline = null;

  const cleanup = (reason = 'session_done', drainMs = 500) => {
    if (cleaningUp) return;
    cleaningUp = true;
    if (reason !== 'session_done') roomAborts.add(1, { reason });
    if (initDeadline) clearTimeout(initDeadline);
    // Two-phase teardown to avoid recycle-race app errors: stop the timers
    // first so no new pings/state messages are queued, drain any in-flight
    // messages for 500ms (relay forwards / acks), then close the sockets.
    // Closing display while controllers still have pings in transit produces
    // ~10 spurious "target not found" errors per session — pure noise.
    timers.forEach(clearInterval);
    setTimeout(() => {
      for (const s of sockets) {
        try {
          // Strip handlers BEFORE close so the VU doesn't wedge waiting for a
          // close-handshake callback under high load.
          s.onopen = s.onmessage = s.onerror = s.onclose = null;
          s.close();
        } catch (_) {}
      }
    }, drainMs);
  };

  // Join barrier: only start sending play traffic once all 4 controllers are
  // joined. Without this, controllers' input loops fire as each one joins,
  // which means the relay sees a 2-3-client room for most of a session's
  // lifetime — the ratio we want to measure (5 clients/room) never lands.
  const startPlay = () => {
    if (playStarted) return;
    // displayIndex is guaranteed non-null here: startPlay() only runs from
    // controller.onmessage on a `joined`, and controllers are spawned
    // 100ms after `created` sets displayIndex.
    if (joinedCtrlIndices.size < CONTROLLERS) return;
    playStarted = true;

    // Display unicasts state to a random joined controller.
    timers.push(setInterval(() => {
      if (cleaningUp) return;
      if (display.readyState !== 1) return;
      const arr = [...joinedCtrlIndices];
      const ctrlIndex = arr[Math.floor(Math.random() * arr.length)];
      display.send(JSON.stringify({
        type: 'send', to: ctrlIndex,
        data: { type: 'player_state', t: Date.now(), pad: STATE_PAD },
      }));
    }, STATE_PERIOD_MS));

    // Each controller pings the display; display echoes the pong.
    for (const ws of controllerSockets) {
      timers.push(setInterval(() => {
        if (cleaningUp) return;
        if (ws.readyState !== 1) return;
        ws.send(JSON.stringify({
          type: 'send', to: displayIndex,
          data: { type: 'lt_ping', t0: Date.now() },
        }));
        pingsSent.add(1);
      }, INPUT_PERIOD_MS));
    }
  };

  // --- Display ---
  display = new WebSocket(RELAY_URL);
  sockets.push(display);

  // If `created` never arrives, the iteration would otherwise hang until
  // gracefulStop kills it — masking the failure mode this test exists to find.
  initDeadline = setTimeout(() => {
    console.warn(`[INIT_TIMEOUT] sid=${sid} no 'created' within 10s`);
    cleanup('init_timeout', 0);
  }, 10_000);

  display.onopen = () => {
    display.send(JSON.stringify({
      type: 'create', clientId: displayId, maxClients: CONTROLLERS + 1,
    }));
  };
  display.onerror = () => {
    connErrors.add(1, { side: 'display' });
    console.warn(`[WS_ERROR] sid=${sid} side=display`);
    cleanup('display_error', FAILURE_BACKOFF_MS);
  };
  display.onclose = (e) => {
    const code = String(e?.code ?? 'na');
    wsClose.add(1, { side: 'display', code });
    // Suppress warns for clean closes (code=1000) — those are our own teardown
    // or graceful server stops, not failure signal.
    if (code !== '1000') {
      console.warn(`[WS_CLOSE] sid=${sid} side=display code=${code} reason=${e?.reason || ''}`);
    }
    cleanup('display_close', FAILURE_BACKOFF_MS);
  };
  display.onmessage = (e) => {
    if (cleaningUp) return;
    let m;
    try { m = JSON.parse(e.data); } catch (_) { return; }
    if (m && typeof m.data === 'string') {
      try { m.data = JSON.parse(m.data); } catch (_) {}
    }

    if (m.type === 'created') {
      clearTimeout(initDeadline);
      room = m.room;
      displayIndex = m.index;
      instance = m.instance || null;   // controllers pin to the same machine
      setTimeout(spawnControllers, 100);
      setTimeout(cleanup, SESSION_DURATION_MS);
      // Silent-join detection: if `playStarted` is still false 15s after
      // controllers spawn, some `joined` never arrived (e.g. relay accepted
      // the socket but never responded). Without this guard the room would
      // sit idle for the full SESSION_DURATION_MS, silently emitting zero
      // RTT samples — the exact mode this test is meant to catch.
      setTimeout(() => {
        if (!playStarted && !cleaningUp) {
          console.warn(`[JOIN_STALL] sid=${sid} only ${joinedCtrlIndices.size}/${CONTROLLERS} ctrls joined`);
          cleanup('join_stall', 0);
        }
      }, 15_000);
    } else if (m.type === 'message' && m.data?.type === 'lt_ping') {
      display.send(JSON.stringify({
        type: 'send', to: m.from,
        data: { type: 'lt_pong', t0: m.data.t0 },
      }));
    } else if (m.type === 'error') {
      const kind = appErrorKind(m.message);
      appErrors.add(1, { side: 'display', kind });
      if (kind === 'target_not_found') {
        targetMissing.add(1, { side: 'display' });
        // Match controller behavior: a missing target means the room is no
        // longer usable (the peer is gone), so abort rather than count
        // errors for the rest of the session.
        cleanup('target_missing', 0);
      }
      console.warn(`[APP_ERROR] sid=${sid} display: ${m.message}`);
    }
  };

  // --- Controllers ---
  // Pin to the display's room and machine using the relay's path + instance
  // routing hints so cross-region/cross-machine joins land on the owner.
  function spawnControllers() {
    const url = roomSocketUrl(room, instance);
    for (const cid of ctrlIds) {
      const ws = new WebSocket(url);
      sockets.push(ws);
      controllerSockets.push(ws);

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'join', clientId: cid, room }));
      };
      ws.onerror = () => {
        connErrors.add(1, { side: 'controller' });
        console.warn(`[WS_ERROR] sid=${sid} side=controller ctrl=${cid}`);
        // Match display behavior: a controller error means the room can't
        // produce meaningful RTT samples, so abort. cleanup() guards against
        // re-entry, so cascading closes from sibling sockets are no-ops.
        cleanup('controller_error', FAILURE_BACKOFF_MS);
      };
      ws.onclose = (e) => {
        const code = String(e?.code ?? 'na');
        wsClose.add(1, { side: 'controller', code });
        if (code !== '1000') {
          console.warn(`[WS_CLOSE] sid=${sid} side=controller ctrl=${cid} code=${code} reason=${e?.reason || ''}`);
          cleanup('controller_close', FAILURE_BACKOFF_MS);
        }
      };
      ws.onmessage = (e) => {
        if (cleaningUp) return;
        let m;
        try { m = JSON.parse(e.data); } catch (_) { return; }
        if (m && typeof m.data === 'string') {
          try { m.data = JSON.parse(m.data); } catch (_) {}
        }

        if (m.type === 'joined') {
          joinedCtrlIndices.add(m.index);
          startPlay();
        } else if (m.type === 'message' && m.data?.type === 'lt_pong') {
          rtt.add(Date.now() - m.data.t0, currentStageTag());
          pongsRecv.add(1);
        } else if (m.type === 'error') {
          const kind = appErrorKind(m.message);
          appErrors.add(1, { side: 'controller', kind });
          if (kind === 'target_not_found') {
            targetMissing.add(1, { side: 'controller' });
            pingsFailed.add(1, { reason: 'target_not_found' });
            cleanup('target_missing', 0);
          }
          console.warn(`[APP_ERROR] sid=${sid} ctrl=${cid}: ${m.message}`);
        }
      };
    }
  }
}
