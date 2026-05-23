// Unwind monitor service — wraps sdk/unwind.js as a managed process and
// exposes its detection events over HTTP.
//
// The actual half-fill detection lives in sdk/unwind.js (unchanged). This
// service spawns it, captures its stdout/stderr into the parent stack log,
// and reads unwind.log to answer event queries.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendJson, methodNotAllowed, notFound } from '../shared/http.mjs';

const PORT = Number(process.env.UNWIND_MONITOR_PORT || 8085);
const HOST = process.env.UNWIND_MONITOR_HOST || '127.0.0.1';
const PAXIOM_DIR = process.env.PAXIOM_DIR || `${process.env.HOME}/paxiom`;
const UNWIND_LOG = process.env.UNWIND_LOG || join(PAXIOM_DIR, 'unwind.log');
const here = dirname(fileURLToPath(import.meta.url));
const MONITOR_SCRIPT = resolve(here, '../../sdk/unwind.js');
const AUTOSTART = process.env.UNWIND_MONITOR_AUTOSTART !== '0';

const state = {
  service: 'UNWIND-MONITOR',
  child: null,
  startedAt: null,
  stoppedAt: null,
  exitCode: null,
  shouldRun: false,
  restartCount: 0,
  lastRestartAt: null,
  restartWindow: [],
};

const RESTART_BACKOFF_MS = 3000;
const RESTART_RATE_LIMIT = 10;
const RESTART_RATE_WINDOW_MS = 5 * 60_000;

function spawnMonitor() {
  if (state.child) return state;
  const now = Date.now();
  state.restartWindow = state.restartWindow.filter((t) => now - t < RESTART_RATE_WINDOW_MS);
  if (state.restartWindow.length >= RESTART_RATE_LIMIT) {
    console.error(`[unwind-monitor] restart rate limit hit (${RESTART_RATE_LIMIT} in ${RESTART_RATE_WINDOW_MS / 1000}s) — giving up.`);
    state.shouldRun = false;
    return state;
  }
  state.restartWindow.push(now);

  const child = spawn('node', [MONITOR_SCRIPT], {
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
    console.log(`[unwind-monitor] child exited (code=${code} signal=${signal})`);
    if (state.shouldRun) {
      state.restartCount++;
      state.lastRestartAt = new Date().toISOString();
      console.log(`[unwind-monitor] watchdog: respawning in ${RESTART_BACKOFF_MS}ms (restart #${state.restartCount})`);
      setTimeout(() => { if (state.shouldRun && !state.child) spawnMonitor(); }, RESTART_BACKOFF_MS);
    }
  });
  child.on('error', (err) => console.error(`[unwind-monitor] child error: ${err.message}`));
  console.log(`[unwind-monitor] spawned pid=${child.pid}${state.restartCount ? ` (after ${state.restartCount} restart(s))` : ''}`);
  return state;
}

function stopMonitor() {
  if (!state.child) return state;
  state.shouldRun = false;
  state.child.kill('SIGTERM');
  return state;
}

function readEvents({ limit = 50, category = null } = {}) {
  if (!existsSync(UNWIND_LOG)) return { count: 0, events: [] };
  const lines = readFileSync(UNWIND_LOG, 'utf8').split('\n').filter(Boolean);
  const out = [];
  let halfFills = 0;
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    try {
      const row = JSON.parse(lines[i]);
      if (row.category === 'HALF_BUY' || row.category === 'HALF_SELL') halfFills++;
      if (category && row.category !== category) continue;
      out.push(row);
    } catch {}
  }
  return { count: out.length, totalLines: lines.length, halfFillCount: halfFills, events: out };
}

export function createApp() {
  return createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true, service: 'UNWIND-MONITOR' });
    if (url.pathname === '/v1/unwind/status') {
      const stat = existsSync(UNWIND_LOG)
        ? { path: UNWIND_LOG, sizeBytes: statSync(UNWIND_LOG).size }
        : null;
      return sendJson(res, 200, {
        service: 'UNWIND-MONITOR',
        running: !!state.child,
        pid: state.child?.pid ?? null,
        startedAt: state.startedAt,
        stoppedAt: state.stoppedAt,
        exitCode: state.exitCode,
        shouldRun: state.shouldRun,
        restartCount: state.restartCount,
        lastRestartAt: state.lastRestartAt,
        log: stat,
      });
    }
    if (url.pathname === '/v1/unwind/events') {
      const limit    = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') || 50)));
      const category = url.searchParams.get('category') || null;
      return sendJson(res, 200, readEvents({ limit, category }));
    }
    if (url.pathname === '/v1/unwind/start') {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
      spawnMonitor();
      return sendJson(res, 200, { running: true, pid: state.child?.pid ?? null });
    }
    if (url.pathname === '/v1/unwind/stop') {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
      stopMonitor();
      return sendJson(res, 200, { stopping: true });
    }
    return notFound(res);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (AUTOSTART) spawnMonitor();
  process.on('SIGTERM', () => { stopMonitor(); setTimeout(() => process.exit(0), 500); });
  process.on('SIGINT',  () => { stopMonitor(); setTimeout(() => process.exit(0), 500); });
  createApp().listen(PORT, HOST, () => {
    console.log(`unwind-monitor service listening on http://${HOST}:${PORT}`);
  });
}
