// Price scanner service — wraps sdk/price-feeder.js as a managed process and
// exposes its state over HTTP so the UI and other Phase 1 services can read it.
//
// The actual scanning logic lives in sdk/price-feeder.js (unchanged). This
// service spawns it, captures its stdout/stderr into the parent stack log,
// and reads opportunities.log to answer status queries.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendJson, methodNotAllowed, notFound } from '../shared/http.mjs';

const PORT = Number(process.env.PRICE_SCANNER_PORT || 8084);
const HOST = process.env.PRICE_SCANNER_HOST || '127.0.0.1';
const PAXIOM_DIR  = process.env.PAXIOM_DIR || `${process.env.HOME}/paxiom`;
const SCANNER_LOG = process.env.LOG_FILE || join(PAXIOM_DIR, 'opportunities.log');
const here = dirname(fileURLToPath(import.meta.url));
const SCANNER_SCRIPT = resolve(here, '../../sdk/price-feeder.js');
const AUTOSTART = process.env.PRICE_SCANNER_AUTOSTART !== '0';

const state = {
  service: 'PRICE-SCANNER',
  child: null,
  startedAt: null,
  stoppedAt: null,
  exitCode: null,
  shouldRun: false,    // operator intent — drives the watchdog
  restartCount: 0,     // total restarts since service start
  lastRestartAt: null,
  restartWindow: [],   // timestamps of recent restarts (for rate limiting)
};

const RESTART_BACKOFF_MS = 3000;          // wait before respawn
const RESTART_RATE_LIMIT = 10;            // max restarts per window
const RESTART_RATE_WINDOW_MS = 5 * 60_000; // 5 minutes

function spawnScanner() {
  if (state.child) return state;
  // Rate-limit restarts so a tight crash loop doesn't burn the box.
  const now = Date.now();
  state.restartWindow = state.restartWindow.filter((t) => now - t < RESTART_RATE_WINDOW_MS);
  if (state.restartWindow.length >= RESTART_RATE_LIMIT) {
    console.error(`[price-scanner] restart rate limit hit (${RESTART_RATE_LIMIT} in ${RESTART_RATE_WINDOW_MS / 1000}s) — giving up. Operator must restart manually.`);
    state.shouldRun = false;
    return state;
  }
  state.restartWindow.push(now);

  const child = spawn('node', [SCANNER_SCRIPT], {
    cwd: PAXIOM_DIR,
    env: { ...process.env, PAXIOM_DIR },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  state.child = child;
  state.startedAt = new Date().toISOString();
  state.stoppedAt = null;
  state.exitCode = null;
  state.shouldRun = true;
  child.on('exit', (code, signal) => {
    state.child = null;
    state.stoppedAt = new Date().toISOString();
    state.exitCode = code ?? signal;
    console.log(`[price-scanner] child exited (code=${code} signal=${signal})`);
    // Watchdog: respawn if the operator hasn't asked us to stop.
    if (state.shouldRun) {
      state.restartCount++;
      state.lastRestartAt = new Date().toISOString();
      console.log(`[price-scanner] watchdog: respawning in ${RESTART_BACKOFF_MS}ms (restart #${state.restartCount})`);
      setTimeout(() => { if (state.shouldRun && !state.child) spawnScanner(); }, RESTART_BACKOFF_MS);
    }
  });
  child.on('error', (err) => console.error(`[price-scanner] child error: ${err.message}`));
  console.log(`[price-scanner] spawned pid=${child.pid}${state.restartCount ? ` (after ${state.restartCount} restart(s))` : ''}`);
  return state;
}

function stopScanner() {
  if (!state.child) return state;
  state.shouldRun = false;  // tell the watchdog not to respawn
  state.child.kill('SIGTERM');
  return state;
}

function readRecentOpps({ limit = 50, minSpread = 0 } = {}) {
  if (!existsSync(SCANNER_LOG)) return { count: 0, opps: [] };
  const lines = readFileSync(SCANNER_LOG, 'utf8').split('\n').filter(Boolean);
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    try {
      const row = JSON.parse(lines[i]);
      if (Number(row.spreadPct) >= minSpread) out.push(row);
    } catch {}
  }
  return { count: out.length, totalLines: lines.length, opps: out };
}

function logStat() {
  if (!existsSync(SCANNER_LOG)) return null;
  const s = statSync(SCANNER_LOG);
  return { path: SCANNER_LOG, sizeBytes: s.size, modifiedAt: s.mtime.toISOString() };
}

export function createApp() {
  return createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true, service: 'PRICE-SCANNER' });
    if (url.pathname === '/v1/scanner/status') {
      return sendJson(res, 200, {
        service: 'PRICE-SCANNER',
        running: !!state.child,
        pid: state.child?.pid ?? null,
        startedAt: state.startedAt,
        stoppedAt: state.stoppedAt,
        exitCode: state.exitCode,
        shouldRun: state.shouldRun,
        restartCount: state.restartCount,
        lastRestartAt: state.lastRestartAt,
        log: logStat(),
      });
    }
    if (url.pathname === '/v1/scanner/opportunities') {
      const limit     = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')     || 50)));
      const minSpread = Number(url.searchParams.get('minSpread') || 0);
      return sendJson(res, 200, readRecentOpps({ limit, minSpread }));
    }
    if (url.pathname === '/v1/scanner/start') {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
      spawnScanner();
      return sendJson(res, 200, { running: true, pid: state.child?.pid ?? null });
    }
    if (url.pathname === '/v1/scanner/stop') {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
      stopScanner();
      return sendJson(res, 200, { stopping: true });
    }
    return notFound(res);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (AUTOSTART) spawnScanner();
  process.on('SIGTERM', () => { stopScanner(); setTimeout(() => process.exit(0), 500); });
  process.on('SIGINT',  () => { stopScanner(); setTimeout(() => process.exit(0), 500); });
  createApp().listen(PORT, HOST, () => {
    console.log(`price-scanner service listening on http://${HOST}:${PORT}`);
  });
}
