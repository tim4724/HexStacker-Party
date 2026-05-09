// k6 load test for the Party-Sockets relay.
//
// Each k6 iteration = one game session: 1 fake display + N fake controllers
// in one room. Defaults model an active 8-player session:
//   - Each controller sends a tagged input every 250ms (4 Hz) — approximates
//     1 Hz PING + 3 Hz INPUT bursts during fast gameplay.
//   - Display echoes every input back as a PONG so we can measure RTT.
//   - Display sends a PLAYER_STATE-sized message to one random controller
//     every 600ms — approximates real `line_clear` cadence across 8 players.
// Resulting per-session rate ≈ 65 msg/s, in the ballpark of real busy play.
//
// STATE_BYTES (default 60) is intentionally small: this test characterises
// routing, RTT, and message-rate handling, not bandwidth. Real `player_state`
// payloads are several hundred bytes; multiply throughput numbers by ~5–10×
// if you need a bandwidth estimate.
//
// When SESSION_DURATION_MS elapses, the iteration tears down and k6 starts
// a fresh one in the same VU (= "restart game once it ends").
//
// Install:
//   brew install k6
//
// Run (defaults to wss://ws.hexstacker.com):
//   k6 run scripts/relay-loadtest.k6.js
//
// Tune via env:
//   SESSIONS=50 DURATION=5m CONTROLLERS=8 INPUT_PERIOD=500 STATE_PERIOD=50 \
//     k6 run scripts/relay-loadtest.k6.js
//
// Override target:
//   RELAY_URL=ws://192.168.1.42:8080 k6 run scripts/relay-loadtest.k6.js
//
// Export to Grafana/Prometheus/InfluxDB with k6's --out flag, e.g.:
//   k6 run --out experimental-prometheus-rw scripts/relay-loadtest.k6.js
//
// Server-side metrics: a sidecar scenario scrapes the relay's /metrics endpoint
// (Prometheus text format) every SCRAPE_INTERVAL seconds and emits the gauges
// (live clients, rooms, RSS, heap) as k6 Trends tagged by {instance, region}.
// To cover multiple machines, pass SCRAPE_INSTANCES as a comma-separated list
// of Fly machine IDs — the scraper pins each request via `?instance=<id>`.
// Without it, anycast picks one machine per scrape (fine for single-machine
// setups, partial coverage for fleets).
//
//   SCRAPE_INSTANCES=2872651a443468,6835e22f7d6908 \
//     k6 run scripts/relay-loadtest.k6.js
//   # tip: get IDs from `fly machine list -a <app> --json`

import { WebSocket } from 'k6/websockets';   // stable; experimental wedges on graceful-stop
import { setTimeout, setInterval, clearInterval, clearTimeout } from 'k6/timers';
import { Trend, Counter } from 'k6/metrics';
import http from 'k6/http';
import { sleep } from 'k6';
import exec from 'k6/execution';

const RELAY_URL           = __ENV.RELAY_URL        || 'wss://ws.hexstacker.com';
const SESSIONS            = parseInt(__ENV.SESSIONS         || '10');
const DURATION            = __ENV.DURATION         || '2m';
const RAMP_UP             = __ENV.RAMP_UP          || '30s';  // 0 → SESSIONS over this period
const RAMP_DOWN           = __ENV.RAMP_DOWN        || '15s';  // SESSIONS → 0 wind-down
const CONTROLLERS         = parseInt(__ENV.CONTROLLERS      || '4');
const SESSION_DURATION_MS = parseInt(__ENV.SESSION_DURATION || '60000');
const INPUT_PERIOD_MS     = parseInt(__ENV.INPUT_PERIOD     || '250');
const STATE_PERIOD_MS     = parseInt(__ENV.STATE_PERIOD     || '600');
const STATE_BYTES         = parseInt(__ENV.STATE_BYTES      || '60');
const SESSIONS_PER_VU     = parseInt(__ENV.SESSIONS_PER_VU  || '1');  // pack >1 to bypass cloud VU caps

// Server-side scraping config. METRICS_URL defaults to the http(s) form of
// RELAY_URL with a /metrics path. SCRAPE_INSTANCES, when set, pins each scrape
// via `?instance=<id>` so we cover every machine in the fleet.
const METRICS_URL = __ENV.METRICS_URL
  || (RELAY_URL.replace(/^ws/, 'http').replace(/\?.*$/, '').replace(/\/$/, '') + '/metrics');
const SCRAPE_INTERVAL_S = parseFloat(__ENV.SCRAPE_INTERVAL || '5');
const SCRAPE_INSTANCES = (__ENV.SCRAPE_INSTANCES || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const rtt    = new Trend('relay_rtt_ms', true);   // tagged by {stage, phase, region}
const joinMs = new Trend('relay_join_ms', true);
const sent   = new Counter('relay_msgs_sent');
const recv   = new Counter('relay_msgs_recv');
const errs   = new Counter('relay_conn_errors');
const regionCounter = new Counter('relay_sessions_by_region');     // tagged by region
const instanceCounter = new Counter('relay_sessions_by_instance'); // tagged by instance (8-char prefix)
const pingsSent = new Counter('relay_pings_sent');                 // controller→display
const pongsRecv = new Counter('relay_pongs_recv');                 // diff = lost or late
const wsClose  = new Counter('relay_ws_close');                    // tagged by {code, side}
const appErrors = new Counter('relay_app_errors');                 // server `{type:"error"}` replies — should be 0
// Server-side gauges scraped from the relay's /metrics endpoint.
const serverClients = new Trend('relay_server_clients');           // live WebSocket clients per machine
const serverRooms   = new Trend('relay_server_rooms');              // live rooms per machine
const serverRssMb   = new Trend('relay_server_rss_mb');             // RSS in MB per machine
const serverHeapMb  = new Trend('relay_server_heap_mb');            // JS heap used in MB per machine
const scrapesOk     = new Counter('relay_scrapes_ok');
const scrapeErrors  = new Counter('relay_scrape_errors');

// STAGES env: comma-separated `dur:target` pairs, e.g. "30s:50,90s:50,30s:100,90s:100"
// When set, overrides the simple ramp-up/hold/ramp-down so we can sweep multiple
// session counts in a single test and tag samples by stage.
function parseStages(spec) {
  return spec.split(',').map(s => {
    const [duration, target] = s.split(':');
    return { duration, target: parseInt(target) };
  });
}

const STAGES = __ENV.STAGES
  ? parseStages(__ENV.STAGES)
  : [
      { duration: RAMP_UP,   target: SESSIONS },
      { duration: DURATION,  target: SESSIONS },
      { duration: RAMP_DOWN, target: 0 },
    ];

// STAGE tag binning. We tag every RTT sample with `{stage, phase}` so the summary
// can show "p95 at 30 sessions (steady) vs 150 (steady)" without ramp transitions
// polluting the buckets. Stage = the target VU count of the current stage. Phase =
// 'hold' when the stage holds the previous target (steady-state), 'ramp' when it
// transitions to a new target. Filter on phase:hold for clean percentiles; phase:ramp
// is retained so you can still see what happens during transitions.
function parseDurationSec(d) {
  const m = String(d).match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = m[2] || 's';
  return unit === 'ms' ? n / 1000 : unit === 'm' ? n * 60 : unit === 'h' ? n * 3600 : n;
}

const STAGE_PHASES = (() => {
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
const TOTAL_TEST_S  = STAGE_PHASES.length > 0 ? STAGE_PHASES[STAGE_PHASES.length - 1].end : 60;

function currentStageTag() {
  const elapsed = (Date.now() - exec.scenario.startTime) / 1000;
  for (const p of STAGE_PHASES) {
    if (elapsed < p.end) return { stage: String(p.target), phase: p.phase };
  }
  return { stage: 'post', phase: 'na' };
}

// Bucket relay error replies into a small fixed set so the `kind` tag has bounded
// cardinality. Raw error messages contain dynamic IDs (room, client, target),
// which would create one sub-metric per unique message and balloon the registry.
function classifyAppError(msg) {
  const s = String(msg || '');
  if (/room not found/i.test(s)) return 'room_not_found';
  if (/target.*not found/i.test(s)) return 'target_not_found';
  if (/full|max/i.test(s)) return 'room_full';
  if (/duplicate|already|in use/i.test(s)) return 'duplicate_id';
  if (/invalid|malformed|parse/i.test(s)) return 'invalid_msg';
  return 'other';
}

// --- Prometheus text parser (relay /metrics) -----------------------------
// Minimal: handles `name{labels} value` and `name value`, ignores comments.
// We only care about a handful of gauges; everything else is dropped.
const SCRAPE_GAUGES = {
  'party_sockets_clients':         { trend: serverClients, scale: 1 },
  'party_sockets_rooms':           { trend: serverRooms,   scale: 1 },
  'process_resident_memory_bytes': { trend: serverRssMb,   scale: 1 / (1024 * 1024) },
  'process_heap_used_bytes':       { trend: serverHeapMb,  scale: 1 / (1024 * 1024) },
};

function parseLabels(group) {
  const out = {};
  if (!group) return out;
  const inner = group.slice(1, -1);
  let m;
  const re = /(\w+)="([^"]*)"/g;
  while ((m = re.exec(inner)) !== null) out[m[1]] = m[2];
  return out;
}

function ingestScrape(body) {
  let observedInstance = null;
  const lines = body.split('\n');
  for (const raw of lines) {
    if (!raw || raw.charCodeAt(0) === 35 /*#*/) continue;
    const m = raw.match(/^([a-zA-Z_:][\w:]*)(\{[^}]*\})?\s+([\d.eE+-]+)/);
    if (!m) continue;
    const target = SCRAPE_GAUGES[m[1]];
    if (!target) continue;
    const v = Number(m[3]);
    if (!isFinite(v)) continue;
    const labels = parseLabels(m[2]);
    if (labels.instance) observedInstance = labels.instance;
    target.trend.add(v * target.scale, {
      instance: (labels.instance || 'unknown').slice(0, 12),
      region: labels.region || 'unknown',
    });
  }
  return observedInstance;
}

// Auto-discovery: when the user doesn't pass SCRAPE_INSTANCES, the first scrape
// goes to /metrics anycast (one *running* machine answers), and we learn its
// instance ID. Subsequent scrapes pin to known instances + one anycast probe to
// catch newly-started machines. This avoids waking suspended machines, which
// pinned scrapes would do.
const discoveredInstances = new Set();

function doScrape(url, learn) {
  const r = http.get(url, { timeout: '5s', tags: { name: 'scrape' } });
  if (r.status === 200 && r.body) {
    scrapesOk.add(1);
    const inst = ingestScrape(r.body);
    if (learn && inst) discoveredInstances.add(inst);
  } else {
    scrapeErrors.add(1, { status: String(r.status || 'na') });
  }
}

export function scrapeMetrics() {
  if (SCRAPE_INSTANCES.length > 0) {
    for (const id of SCRAPE_INSTANCES) doScrape(`${METRICS_URL}?instance=${encodeURIComponent(id)}`, false);
  } else {
    // One unpinned probe per cycle — both bootstraps discovery and catches
    // freshly-started machines the load test triggered.
    doScrape(METRICS_URL, true);
    // Pin to every machine we've already discovered so coverage stays complete
    // even after fly-proxy routes us elsewhere.
    for (const id of discoveredInstances) {
      doScrape(`${METRICS_URL}?instance=${encodeURIComponent(id)}`, true);
    }
  }
  sleep(SCRAPE_INTERVAL_S);
}

export const options = {
  scenarios: {
    sessions: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: STAGES,
      gracefulRampDown: '5s',
      gracefulStop: '5s',
    },
    // Sidecar scraper: 1 VU pulls /metrics every SCRAPE_INTERVAL_S for the
    // duration of the sessions scenario. Emits relay-side gauges as Trends.
    metrics_scraper: {
      executor: 'constant-vus',
      exec: 'scrapeMetrics',
      vus: 1,
      duration: `${Math.ceil(TOTAL_TEST_S)}s`,
      startTime: '0s',
      gracefulStop: '2s',
      tags: { scenario: 'metrics_scraper' },
    },
  },
  // k6's default trend summary omits p50, p99, and count — add them so we get a
  // full distribution for every Trend (including all `relay_rtt_ms{region:*}` subs).
  summaryTrendStats: ['count', 'avg', 'min', 'med', 'max', 'p(50)', 'p(95)', 'p(99)'],
  // k6 only emits sub-metric stats in the summary for tags that are pre-registered
  // via thresholds. Trivially-true `count>=0` thresholds force them into the summary
  // without polluting pass/fail. Region/code lists are the ones we expect to see.
  thresholds: (() => {
    const t = {
      relay_rtt_ms:       ['p(95)<150', 'p(99)<400'],
      relay_conn_errors:  ['count<10'],
    };
    for (const r of ['fra', 'iad', 'nrt', 'unknown']) {
      t[`relay_sessions_by_region{region:${r}}`] = ['count>=0'];
      t[`relay_rtt_ms{region:${r}}`] = ['avg>=0'];   // trend: count not supported
    }
    // Pre-register {stage,phase} sub-metrics so RTT-by-stage lands in the summary,
    // separated into hold (steady-state) vs ramp (transition) buckets.
    for (const tgt of STAGE_TARGETS) {
      for (const phase of ['hold', 'ramp']) {
        t[`relay_rtt_ms{stage:${tgt},phase:${phase}}`] = ['avg>=0'];
      }
    }
    for (const side of ['display', 'controller']) {
      t[`relay_conn_errors{side:${side}}`] = ['count>=0'];
      // 4000 = relay eviction (clientId collision); shouldn't appear in normal runs.
      for (const code of ['1000', '1001', '1006', '1011', '4000', 'na']) {
        t[`relay_ws_close{side:${side},code:${code}}`] = ['count>=0'];
      }
      for (const kind of ['room_not_found', 'target_not_found', 'room_full', 'duplicate_id', 'invalid_msg', 'other']) {
        t[`relay_app_errors{side:${side},kind:${kind}}`] = ['count>=0'];
      }
    }
    // Server-side scrape metrics. Pre-register sub-metrics so the summary
    // surfaces per-instance/region rows. If SCRAPE_INSTANCES is set we know
    // exactly which machines to break out; otherwise fall back to known regions.
    t['relay_scrapes_ok'] = ['count>=0'];
    t['relay_scrape_errors'] = ['count<10'];
    const serverGauges = ['relay_server_clients', 'relay_server_rooms', 'relay_server_rss_mb', 'relay_server_heap_mb'];
    if (SCRAPE_INSTANCES.length > 0) {
      for (const inst of SCRAPE_INSTANCES) {
        const short = inst.slice(0, 12);
        for (const m of serverGauges) t[`${m}{instance:${short}}`] = ['avg>=0'];
      }
    } else {
      for (const r of ['fra', 'iad', 'nrt', 'unknown']) {
        for (const m of serverGauges) t[`${m}{region:${r}}`] = ['avg>=0'];
      }
    }
    return t;
  })(),
  // Optional DNS override — set HOSTS_OVERRIDE=ws.hexstacker.com=192.168.1.115
  // to bypass NAT hairpin when testing from same LAN as the relay node.
  hosts: (() => {
    const ov = __ENV.HOSTS_OVERRIDE;
    if (!ov) return undefined;
    const out = {};
    for (const pair of ov.split(',')) {
      const [host, ip] = pair.split('=');
      if (host && ip) out[host.trim()] = ip.trim();
    }
    return out;
  })(),
  // Cloud-only — ignored when running locally with `k6 run`.
  // Free tier caps: 100 VUs and 1 load zone per test. Default to Frankfurt
  // (closest to relay); override with LOAD_ZONE env var for geo testing.
  cloud: {
    name: 'Party-Sockets relay loadtest',
    distribution: {
      zone: { loadZone: __ENV.LOAD_ZONE || 'amazon:de:frankfurt', percent: 100 },
    },
  },
};

const STATE_PAD = 'x'.repeat(STATE_BYTES);

// Surface tagged sub-metrics that k6's legacy summary drops on the floor.
// We dig into `data.metrics` for keys like `relay_sessions_by_region{region:xxx}`
// and emit compact breakdowns alongside the standard summary.
export function handleSummary(data) {
  const regions = {};
  const instances = {};
  const rttByRegion = {};
  const rttByStage = {};   // keyed `${target}/${phase}` so hold and ramp don't blend
  const closes = {};
  const connErrors = {};
  const appErrorKinds = {};
  const relayState = {};   // keyed `${region}/${instance}` from /metrics scrapes
  for (const [k, v] of Object.entries(data.metrics)) {
    if (k.startsWith('relay_sessions_by_region{') && v?.values?.count != null) {
      const tag = k.match(/region:([^}]+)/)?.[1] || 'unknown';
      regions[tag] = v.values.count;
    } else if (k.startsWith('relay_sessions_by_instance{') && v?.values?.count != null) {
      const inst = k.match(/instance:([^,}]+)/)?.[1] || 'unknown';
      const reg  = k.match(/region:([^,}]+)/)?.[1] || 'unknown';
      instances[`${reg}/${inst}`] = v.values.count;
    } else if (k.startsWith('relay_rtt_ms{') && v?.values) {
      const stage  = k.match(/stage:([^,}]+)/)?.[1];
      const phase  = k.match(/phase:([^,}]+)/)?.[1];
      const region = k.match(/region:([^,}]+)/)?.[1];
      const stats = {
        count: v.values.count,
        avg: v.values.avg,
        p50: v.values['p(50)'],
        p95: v.values['p(95)'],
        p99: v.values['p(99)'],
        max: v.values.max,
      };
      if (stage && phase) {
        rttByStage[`${stage}/${phase}`] = stats;
      } else if (region && !stage) {
        rttByRegion[region] = stats;
      }
    } else if (k.startsWith('relay_ws_close{') && v?.values?.count != null) {
      const code = k.match(/code:([^,}]+)/)?.[1] || 'na';
      const side = k.match(/side:([^,}]+)/)?.[1] || 'na';
      closes[`${side}/${code}`] = v.values.count;
    } else if (k.startsWith('relay_conn_errors{') && v?.values?.count != null) {
      const side = k.match(/side:([^,}]+)/)?.[1] || 'na';
      connErrors[side] = v.values.count;
    } else if (k.startsWith('relay_app_errors{') && v?.values?.count != null) {
      const side = k.match(/side:([^,}]+)/)?.[1] || 'na';
      const kind = k.match(/kind:([^,}]+)/)?.[1] || 'na';
      appErrorKinds[`${side}/${kind}`] = v.values.count;
    } else if (/^relay_server_(clients|rooms|rss_mb|heap_mb)\{/.test(k) && v?.values) {
      const inst   = k.match(/instance:([^,}]+)/)?.[1];
      const region = k.match(/region:([^,}]+)/)?.[1];
      const which  = k.match(/^relay_server_(\w+)\{/)?.[1];
      // Sub-metric keys pre-registered by instance OR region only — the other
      // tag isn't carried in the summary key, so fall through gracefully.
      const tag    = inst ? (region ? `${region}/${inst}` : inst) : (region || 'unknown');
      const r = (relayState[tag] = relayState[tag] || {});
      r[`${which}_avg`] = v.values.avg;
      r[`${which}_max`] = v.values.max;
    }
  }
  const pings = data.metrics.relay_pings_sent?.values?.count ?? 0;
  const pongs = data.metrics.relay_pongs_recv?.values?.count ?? 0;
  const appErrTotal = data.metrics.relay_app_errors?.values?.count ?? 0;
  const connErrTotal = data.metrics.relay_conn_errors?.values?.count ?? 0;
  const scrapesOkCount = data.metrics.relay_scrapes_ok?.values?.count ?? 0;
  const scrapeErrCount = data.metrics.relay_scrape_errors?.values?.count ?? 0;
  data.regions = regions;
  data.instances = instances;
  data.rttByRegion = rttByRegion;
  data.rttByStage = rttByStage;
  data.closes = closes;
  data.connErrors = connErrors;
  data.appErrors = appErrTotal;
  data.appErrorKinds = appErrorKinds;
  data.relayState = relayState;
  data.scrapeStats = { ok: scrapesOkCount, errors: scrapeErrCount };
  data.pingLoss = { pings_sent: pings, pongs_recv: pongs, missing: pings - pongs };
  const sortStageKey = (a, b) => {
    const [ta, pa] = a.split('/');
    const [tb, pb] = b.split('/');
    return Number(ta) - Number(tb) || (pa === 'hold' ? -1 : 1);
  };
  const fmtRtt = (s) =>
    `count=${s.count} avg=${s.avg?.toFixed(1)} p50=${s.p50?.toFixed(1)} p95=${s.p95?.toFixed(1)} p99=${s.p99?.toFixed(1)} max=${s.max?.toFixed(0)}`;
  const lines = [
    `\n  █ REGION BREAKDOWN`,
    ...Object.entries(regions).map(([r, n]) => `    ${r}: ${n}`),
    `\n  █ INSTANCE BREAKDOWN (region/id-prefix → sessions)`,
    ...Object.entries(instances).map(([k, n]) => `    ${k}: ${n}`),
    `\n  █ RTT BY REGION (ms)`,
    ...Object.entries(rttByRegion).map(([r, s]) =>
      `    ${r}: ${fmtRtt(s)}`),
    `\n  █ RTT BY STAGE (ms — target VUs / phase; filter phase:hold for steady-state)`,
    ...Object.entries(rttByStage)
      .sort(([a], [b]) => sortStageKey(a, b))
      .map(([k, s]) => `    ${k.padEnd(10)} ${fmtRtt(s)}`),
    `\n  █ WS CLOSES (side/code → count)`,
    ...Object.entries(closes).map(([k, n]) => `    ${k}: ${n}`),
    `\n  █ CONN ERRORS (WS-level connect failures, by side)`,
    `    total=${connErrTotal}`,
    ...Object.entries(connErrors).map(([s, n]) => `    ${s}: ${n}`),
    `\n  █ APP ERRORS (server {type:'error'} replies; should be 0)`,
    `    total=${appErrTotal}`,
    ...Object.entries(appErrorKinds).map(([k, n]) => `    ${k}: ${n}`),
    `\n  █ RELAY SERVER STATE (peak / avg, scraped from /metrics)`,
    `    scrapes ok=${scrapesOkCount} errors=${scrapeErrCount}` +
      (scrapesOkCount === 0 ? '   (no relay-side data — scraper got nothing)' : ''),
    ...Object.entries(relayState)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([tag, r]) => {
        const fmt = (avg, max, suffix = '') => {
          if (max == null) return '—';
          return `${max.toFixed(0)}${suffix} (avg ${avg.toFixed(0)}${suffix})`;
        };
        return `    ${tag.padEnd(22)} clients=${fmt(r.clients_avg, r.clients_max)}  rooms=${fmt(r.rooms_avg, r.rooms_max)}  rss=${fmt(r.rss_mb_avg, r.rss_mb_max, ' MB')}  heap=${fmt(r.heap_mb_avg, r.heap_mb_max, ' MB')}`;
      }),
    `\n  █ PING LOSS`,
    `    sent=${pings} recv=${pongs} missing=${pings - pongs} (${pings ? ((pings - pongs) / pings * 100).toFixed(2) : 0}%)`,
  ];
  return {
    'stdout': lines.join('\n') + '\n',
    [`${__ENV.SUMMARY_EXPORT || '/tmp/k6-summary.json'}`]: JSON.stringify(data, null, 2),
  };
}

export default function () {
  // Spawn SESSIONS_PER_VU independent sessions concurrently in this VU. Each
  // is fully isolated (own room, display, controllers, timers). Lets us reach
  // high effective session counts on plans with low VU caps.
  // The default function returns immediately after this loop, but k6 keeps the
  // VU alive until every k6/timers callback has cleared and every WebSocket has
  // closed — so sessions actually run concurrently for SESSION_DURATION_MS.
  for (let s = 0; s < SESSIONS_PER_VU; s++) {
    runSession(`${__VU}-${__ITER}-${s}`);
  }
}

function runSession(sid) {
  const displayId = `d-${sid}`;
  const ctrlIds   = [];
  for (let i = 0; i < CONTROLLERS; i++) ctrlIds.push(`c-${sid}-${i}`);

  const sockets = [];
  const timers  = [];
  const joinedCtrls = new Set();   // ids that have completed their `joined` ack
  let stateTimerOn = false;
  let room      = null;   // assigned by relay in `created` message
  let instance  = null;   // assigned by relay in `created` — controllers pin to this
  let region    = 'unknown';   // populated when `created` arrives — used to tag RTT

  const cleanup = () => {
    timers.forEach(clearInterval);
    for (const s of sockets) {
      try {
        // Strip handlers BEFORE close so k6 doesn't keep the VU alive waiting
        // for a close-handshake callback under high load.
        s.onopen = null;
        s.onmessage = null;
        s.onerror = null;
        s.onclose = null;
        s.close();
      } catch (_) {}
    }
  };

  // STATE timer is the display unicast loop. Start it only after at least one
  // controller has joined; pick targets only from the joined set so we never
  // address a not-yet-registered client (which the relay rightly rejects with
  // "Target client not found").
  const startStateTimer = () => {
    if (stateTimerOn) return;
    stateTimerOn = true;
    timers.push(setInterval(() => {
      if (display.readyState !== 1) return;
      if (joinedCtrls.size === 0) return;
      const arr = [...joinedCtrls];
      const cid = arr[Math.floor(Math.random() * arr.length)];
      display.send(JSON.stringify({
        type: 'send', to: cid,
        data: { type: 'player_state', t: Date.now(), pad: STATE_PAD },
      }));
      sent.add(1);
    }, STATE_PERIOD_MS));
  };

  // --- Display ------------------------------------------------------------
  const dT0   = Date.now();
  const display = new WebSocket(RELAY_URL);
  sockets.push(display);

  // Watchdog: if `created` never arrives (relay drop, malformed reply), the
  // iteration would otherwise hang until k6's gracefulStop kills it — masking
  // exactly the failure modes this test exists to surface.
  const initDeadline = setTimeout(() => {
    console.warn(`[INIT_TIMEOUT] sid=${sid} no 'created' ack within 10s — aborting session`);
    cleanup();
  }, 10_000);

  display.onopen = () => {
    display.send(JSON.stringify({
      type: 'create', clientId: displayId, maxClients: CONTROLLERS + 1,
    }));
    sent.add(1);
  };

  display.onerror = () => errs.add(1, { side: 'display' });
  display.onclose = (e) => wsClose.add(1, { code: String(e?.code ?? 'na'), side: 'display' });

  display.onmessage = (e) => {
    recv.add(1);
    let m;
    try { m = JSON.parse(e.data); } catch (_) { return; }
    // Some relays forward the inner `data` field as a JSON string; normalize.
    if (m && typeof m.data === 'string') {
      try { m.data = JSON.parse(m.data); } catch (_) {}
    }

    if (m.type === 'created') {
      clearTimeout(initDeadline);
      room = m.room;   // relay assigns the room id; controllers must use it
      instance = m.instance || null;   // pin controllers to the same machine
      joinMs.add(Date.now() - dT0);
      region = m.region || 'unknown';
      regionCounter.add(1, { region });
      if (instance) instanceCounter.add(1, { instance: instance.slice(0, 8), region });
      // Region drift detector — warn loudly if anycast routes us off-target.
      // EXPECTED_REGION env var lets the runner declare what they expect.
      if (__ENV.EXPECTED_REGION && region !== __ENV.EXPECTED_REGION) {
        console.warn(`[REGION_DRIFT] sid=${sid} expected=${__ENV.EXPECTED_REGION} got=${region}`);
      }
      setTimeout(spawnControllers, 100);
      // End the iteration after SESSION_DURATION_MS no matter what.
      setTimeout(cleanup, SESSION_DURATION_MS);
    } else if (m.type === 'message' && m.data && m.data.type === 'lt_ping') {
      // Echo input back to the sender so we can measure RTT.
      display.send(JSON.stringify({
        type: 'send', to: m.from,
        data: { type: 'lt_pong', t0: m.data.t0 },
      }));
      sent.add(1);
    } else if (m.type === 'error') {
      // Surface app-level errors so we don't silently regress (e.g. "Room not found").
      // `kind` is bucketed (see classifyAppError) to keep tag cardinality bounded.
      appErrors.add(1, { side: 'display', kind: classifyAppError(m.message) });
      console.warn(`[APP_ERROR] sid=${sid} side=display msg=${m.message}`);
    }
  };

  // --- Controllers --------------------------------------------------------
  // Real clients pin via `?instance=<id>` (carried in the QR fragment) so
  // fly-replay routes them to the machine that holds the room. Without the
  // pin, anycast can land us on a sibling that returns "Room not found".
  function spawnControllers() {
    const pinUrl = instance
      ? `${RELAY_URL}?instance=${encodeURIComponent(instance)}`
      : RELAY_URL;
    for (const cid of ctrlIds) {
      const cT0 = Date.now();
      const ws  = new WebSocket(pinUrl);
      sockets.push(ws);

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'join', clientId: cid, room }));
        sent.add(1);
      };

      ws.onerror = () => errs.add(1, { side: 'controller' });
      ws.onclose = (e) => wsClose.add(1, { code: String(e?.code ?? 'na'), side: 'controller' });

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
          startStateTimer();   // first joined controller arms the display unicast loop
          // Each controller starts its own input loop independently — no
          // need to wait for siblings.
          timers.push(setInterval(() => {
            if (ws.readyState !== 1) return;
            ws.send(JSON.stringify({
              type: 'send', to: displayId,
              data: { type: 'lt_ping', t0: Date.now() },
            }));
            sent.add(1);
            pingsSent.add(1);
          }, INPUT_PERIOD_MS));
        } else if (m.type === 'message' && m.data && m.data.type === 'lt_pong') {
          rtt.add(Date.now() - m.data.t0, { ...currentStageTag(), region });
          pongsRecv.add(1);
        } else if (m.type === 'error') {
          appErrors.add(1, { side: 'controller', kind: classifyAppError(m.message) });
          console.warn(`[APP_ERROR] sid=${sid} side=controller cid=${cid} msg=${m.message}`);
        }
      };
    }
  }
}
