import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { verifyMessage } from 'viem';
import { phase1Catalog } from '../services/catalog/phase1.mjs';
import {
  ROLE_ADMIN, assertBootConfig, isAllowed, roleFor, snapshot as walletSnapshot,
  addWallet, removeWallet, setWalletRole, normalizeAddress,
} from './wallet-registry.mjs';

const PORT = Number(process.env.PAXIOM_UI_PORT || 3000);
const HOST = process.env.PAXIOM_UI_HOST || '127.0.0.1';
const here = dirname(fileURLToPath(import.meta.url));

const sessions = new Map();
const nonces = new Map();
const MAX_NONCES = 1024;

const SERVICE_HEALTH = [
  { id: 'CATALOG', host: 'SERVICE_CATALOG_HOST', port: 'SERVICE_CATALOG_PORT', defaultPort: 8090 },
  { id: 'A-201', host: 'SLOT_STORAGE_PROOF_HOST', port: 'SLOT_STORAGE_PROOF_PORT', defaultPort: 8091 },
  { id: 'A-202', host: 'SYNC_COMMITTEE_HOST', port: 'SYNC_COMMITTEE_PORT', defaultPort: 8080 },
  { id: 'A-203', host: 'CROSS_CHAIN_MESSAGE_HOST', port: 'CROSS_CHAIN_MESSAGE_PORT', defaultPort: 8093 },
  { id: 'A-204', host: 'SIMULATION_SERVICE_HOST', port: 'SIMULATION_SERVICE_PORT', defaultPort: 8094 },
  { id: 'A-205', host: 'HISTORICAL_STATE_HOST', port: 'HISTORICAL_STATE_PORT', defaultPort: 8095 },
  { id: 'COMPLIANCE-001', host: 'COMPLIANCE_SERVICE_HOST', port: 'COMPLIANCE_SERVICE_PORT', defaultPort: 8083 },
  { id: 'PRICE-SCANNER', host: 'PRICE_SCANNER_HOST', port: 'PRICE_SCANNER_PORT', defaultPort: 8084 },
  { id: 'UNWIND-MONITOR', host: 'UNWIND_MONITOR_HOST', port: 'UNWIND_MONITOR_PORT', defaultPort: 8085 },
  { id: 'ARB-RUNNER', host: 'ARB_RUNNER_HOST', port: 'ARB_RUNNER_PORT', defaultPort: 8086 },
];

export function createApp() {
  // Refuse to start without an env seed (M-18). Checked here rather than at
  // module load so this file can be imported by a test without a full
  // environment; the refusal still precedes accepting any connection.
  assertBootConfig();
  return createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return sendHtml(res, readFileSync(resolve(here, 'index.html'), 'utf8'));
      }
      if (req.method === 'GET' && url.pathname === '/api/catalog') {
        return sendJson(res, 200, phase1Catalog());
      }
      if (req.method === 'GET' && url.pathname === '/api/services/health') {
        return sendJson(res, 200, { checkedAt: new Date().toISOString(), services: await checkServices() });
      }
      if (req.method === 'POST' && url.pathname === '/api/session/nonce') {
        const body = await readJson(req);
        return sendJson(res, 200, createLoginChallenge(body.address));
      }
      if (req.method === 'POST' && url.pathname === '/api/session/verify') {
        const body = await readJson(req);
        return sendJson(res, 200, await verifyLogin(body));
      }
      if (req.method === 'GET' && url.pathname === '/api/wallets') {
        if (!adminOrReject(req, res)) return;
        return sendJson(res, 200, walletSnapshot());
      }
      if (req.method === 'POST' && url.pathname === '/api/wallets') {
        const session = adminOrReject(req, res);
        if (!session) return;
        const body = await readJson(req);
        return sendJson(res, 200, addWallet({
          address: body.address, role: body.role, reason: body.reason, actor: session.address,
        }));
      }
      if (req.method === 'DELETE' && url.pathname.startsWith('/api/wallets/')) {
        const session = adminOrReject(req, res);
        if (!session) return;
        const address = decodeURIComponent(url.pathname.slice('/api/wallets/'.length));
        return sendJson(res, 200, removeWallet({ address, actor: session.address }));
      }
      if (req.method === 'POST' && /^\/api\/wallets\/[^/]+\/role$/.test(url.pathname)) {
        const session = adminOrReject(req, res);
        if (!session) return;
        const address = decodeURIComponent(url.pathname.split('/')[3]);
        const body = await readJson(req);
        return sendJson(res, 200, setWalletRole({
          address, role: body.role, reason: body.reason, actor: session.address,
        }));
      }
      if (req.method === 'GET' && url.pathname === '/healthz') {
        return sendJson(res, 200, { ok: true, service: 'PAXIOM-UI' });
      }
      if (req.method === 'GET' && url.pathname === '/api/arb/opportunities') {
        return proxyJson(res, scannerUrl(`/v1/scanner/opportunities${url.search}`));
      }
      if (req.method === 'GET' && url.pathname === '/api/arb/scanner-status') {
        return proxyJson(res, scannerUrl('/v1/scanner/status'));
      }
      if (req.method === 'POST' && (url.pathname === '/api/arb/scanner-start' || url.pathname === '/api/arb/scanner-stop')) {
        if (!authOrReject(req, res)) return;
        const action = url.pathname.endsWith('start') ? 'start' : 'stop';
        return proxyJson(res, scannerUrl(`/v1/scanner/${action}`), 'POST');
      }
      if (req.method === 'GET' && url.pathname === '/api/arb/unwind-events') {
        return proxyJson(res, unwindUrl(`/v1/unwind/events${url.search}`));
      }
      if (req.method === 'GET' && url.pathname === '/api/arb/unwind-status') {
        return proxyJson(res, unwindUrl('/v1/unwind/status'));
      }
      if (req.method === 'GET' && url.pathname === '/api/arb/runner-status') {
        return proxyJson(res, runnerUrl('/v1/runner/status'));
      }
      if (req.method === 'GET' && url.pathname === '/api/arb/runner-wallet') {
        return proxyJson(res, runnerUrl('/v1/runner/wallet'));
      }
      if (req.method === 'GET' && url.pathname === '/api/arb/runner-performance') {
        return proxyJson(res, runnerUrl('/v1/runner/performance'));
      }
      if (req.method === 'GET' && url.pathname === '/api/arb/trades') {
        return proxyJson(res, runnerUrl(`/v1/runner/trades${url.search}`));
      }
      if (req.method === 'POST' && url.pathname === '/api/arb/runner-start') {
        if (!authOrReject(req, res)) return;
        return proxyJson(res, runnerUrl('/v1/runner/start'), 'POST', req);
      }
      if (req.method === 'POST' && url.pathname === '/api/arb/runner-stop') {
        if (!authOrReject(req, res)) return;
        return proxyJson(res, runnerUrl('/v1/runner/stop'), 'POST');
      }
      if (req.method === 'POST' && url.pathname === '/api/arb/emergency-close') {
        if (!authOrReject(req, res)) return;
        return proxyJson(res, runnerUrl('/v1/runner/emergency-close'), 'POST');
      }
      if (req.method === 'POST' && url.pathname === '/api/arb/clear-emergency') {
        if (!authOrReject(req, res)) return;
        return proxyJson(res, runnerUrl('/v1/runner/clear-emergency'), 'POST');
      }
      if (req.method === 'GET' && url.pathname === '/api/arb/external-wallet') {
        return proxyJson(res, runnerUrl(`/v1/runner/external-wallet${url.search}`));
      }
      if (req.method === 'POST' && url.pathname === '/api/arb/withdraw') {
        if (!authOrReject(req, res)) return;
        return proxyJson(res, runnerUrl('/v1/runner/withdraw'), 'POST', req);
      }
      if (req.method === 'GET' && url.pathname === '/api/arb/preflight') {
        return proxyJson(res, runnerUrl(`/v1/runner/preflight${url.search}`));
      }
      if (req.method === 'GET' && url.pathname === '/api/arb/balance-plan') {
        return proxyJson(res, runnerUrl(`/v1/runner/balance-plan${url.search}`));
      }
      if (req.method === 'GET' && url.pathname === '/api/arb/operator-rebalance-quote') {
        if (!authOrReject(req, res)) return;
        return proxyJson(res, runnerUrl(`/v1/runner/operator-rebalance-quote${url.search}`));
      }
      if (req.method === 'POST' && url.pathname === '/api/arb/operator-rebalance') {
        if (!authOrReject(req, res)) return;
        return proxyJson(res, runnerUrl('/v1/runner/operator-rebalance'), 'POST', req);
      }
      if (req.method === 'GET' && url.pathname === '/api/arb/funding-quote') {
        if (!authOrReject(req, res)) return;
        return sendJson(res, 200, await fundingQuote(url.searchParams));
      }
      if (req.method === 'POST' && url.pathname === '/api/arb/test-roundtrip') {
        if (!authOrReject(req, res)) return;
        return proxyJson(res, runnerUrl('/v1/runner/test-roundtrip'), 'POST', req);
      }
      if (req.method === 'GET' && url.pathname === '/api/arb/test-roundtrip-status') {
        return proxyJson(res, runnerUrl('/v1/runner/test-roundtrip-status'));
      }
      if (req.method === 'POST' && url.pathname === '/api/arb/test-crosschain-dust') {
        if (!authOrReject(req, res)) return;
        return proxyJson(res, runnerUrl('/v1/runner/test-crosschain-dust'), 'POST', req);
      }
      if (req.method === 'GET' && url.pathname === '/api/arb/test-crosschain-dust-status') {
        return proxyJson(res, runnerUrl('/v1/runner/test-crosschain-dust-status'));
      }
      if (req.method === 'POST' && url.pathname === '/api/arb/test-half-fill') {
        if (!authOrReject(req, res)) return;
        return proxyJson(res, runnerUrl('/v1/runner/test-half-fill'), 'POST', req);
      }
      if (req.method === 'POST' && url.pathname === '/api/arb/test-crosschain-loop') {
        if (!authOrReject(req, res)) return;
        return proxyJson(res, runnerUrl('/v1/runner/test-crosschain-loop'), 'POST', req);
      }
      return sendJson(res, 404, { error: 'not_found', detail: url.pathname });
    } catch (e) {
      const status = Number.isInteger(e.status) ? e.status : 500;
      const error = status === 403 ? 'forbidden'
        : status === 409 ? 'conflict'
        : status === 404 ? 'not_found'
        : status === 500 ? 'ui_server_error'
        : 'bad_request';
      return sendJson(res, status, { error, detail: e.message });
    }
  });
}

function scannerUrl(path) {
  const host = process.env.PRICE_SCANNER_HOST || '127.0.0.1';
  const port = process.env.PRICE_SCANNER_PORT || 8084;
  return `http://${host}:${port}${path}`;
}

function unwindUrl(path) {
  const host = process.env.UNWIND_MONITOR_HOST || '127.0.0.1';
  const port = process.env.UNWIND_MONITOR_PORT || 8085;
  return `http://${host}:${port}${path}`;
}

function runnerUrl(path) {
  const host = process.env.ARB_RUNNER_HOST || '127.0.0.1';
  const port = process.env.ARB_RUNNER_PORT || 8086;
  return `http://${host}:${port}${path}`;
}

const QUOTE_CHAINS = {
  optimism: 10,
  base: 8453,
  arbitrum: 42161,
};
const QUOTE_TOKENS = {
  optimism: {
    eth: 'ETH',
    usdc: 'USDC',
    weth: '0x4200000000000000000000000000000000000006',
  },
  base: {
    eth: 'ETH',
    usdc: 'USDC',
    weth: '0x4200000000000000000000000000000000000006',
  },
  arbitrum: {
    eth: 'ETH',
    usdc: 'USDC',
    weth: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  },
};

async function fundingQuote(params) {
  const fromChain = params.get('fromChain') || 'base';
  const toChain = params.get('toChain') || '';
  const toAsset = params.get('toAsset') || '';
  const fromAddress = params.get('fromAddress') || '';
  const toAddress = params.get('toAddress') || '';
  const toAmount = params.get('toAmount') || '';
  if (fromChain !== 'base') throw badRequest('only Base ETH source funding is enabled for now');
  if (!QUOTE_CHAINS[toChain]) throw badRequest('unknown toChain');
  if (!QUOTE_TOKENS[toChain]?.[toAsset]) throw badRequest('unknown toAsset');
  if (!/^0x[0-9a-fA-F]{40}$/.test(fromAddress)) throw badRequest('fromAddress must be a 20-byte hex address');
  if (!/^0x[0-9a-fA-F]{40}$/.test(toAddress)) throw badRequest('toAddress must be a 20-byte hex address');
  if (!/^[0-9]+$/.test(toAmount) || BigInt(toAmount) <= 0n) throw badRequest('toAmount must be positive base units');

  const quoteUrl = new URL('https://li.quest/v1/quote/toAmount');
  quoteUrl.search = new URLSearchParams({
    fromChain: String(QUOTE_CHAINS[fromChain]),
    toChain: String(QUOTE_CHAINS[toChain]),
    fromToken: 'ETH',
    toToken: QUOTE_TOKENS[toChain][toAsset],
    fromAddress,
    toAddress,
    toAmount,
    slippage: '0.01',
    order: 'CHEAPEST',
    integrator: 'paxiom',
  }).toString();
  const upstream = await fetch(quoteUrl, { headers: { Accept: 'application/json' } });
  const text = await upstream.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { error: 'quote_parse_failed', detail: text.slice(0, 500) }; }
  if (!upstream.ok) {
    const err = badRequest(body.message || body.error || `quote failed (${upstream.status})`);
    err.quote = body;
    throw err;
  }
  return body;
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// Privileged routes require a valid session token from a successful SIWE login.
// The token is issued by /api/session/verify (sessions Map) and the UI sends it
// as `Authorization: Bearer <token>` on each privileged call.
function requireSession(req) {
  const auth = req.headers['authorization'];
  if (!auth) return null;
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  return sessions.get(token) || null;
}

function authOrReject(req, res) {
  if (process.env.PAXIOM_DISABLE_AUTH === '1') return { address: 'auth-disabled' };
  const session = requireSession(req);
  if (!session) {
    sendJson(res, 401, { error: 'authentication_required', detail: 'connect MetaMask and sign the login challenge' });
    return null;
  }
  // Re-check the allowlist on every request, not just at login. Sessions
  // outlive the roster: without this, removing a wallet (#90) would leave its
  // existing token working until the process restarted, so "remove" would not
  // actually revoke anything. Dropping the session here makes removal
  // immediate and forces a fresh SIWE login if the wallet is re-added.
  if (!isAllowed(session.address)) {
    sessions.delete(session.token);
    sendJson(res, 403, {
      error: 'forbidden',
      detail: 'wallet is no longer allowlisted for this private console',
    });
    return null;
  }
  return session;
}

// Admin-only gate for the operator-configuration surfaces. Session first, so
// an unauthenticated caller gets 401 rather than being told a route is
// admin-only. #92, #96, #98 and #106 gate on this too.
function adminOrReject(req, res) {
  const session = authOrReject(req, res);
  if (!session) return null;
  if (session.address === 'auth-disabled') return session;
  if (roleFor(session.address) !== ROLE_ADMIN) {
    sendJson(res, 403, {
      error: 'forbidden',
      detail: 'this operation requires an admin wallet',
    });
    return null;
  }
  return session;
}

async function proxyJson(res, url, method = 'GET', sourceReq = null) {
  try {
    const init = { method };
    if (sourceReq && method !== 'GET' && method !== 'HEAD') {
      // Forward JSON body for POSTs that carry config (e.g. runner-start).
      let body = '';
      try {
        body = await new Promise((resolve, reject) => {
          const chunks = [];
          sourceReq.on('data', (c) => chunks.push(c));
          sourceReq.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
          sourceReq.on('error', reject);
        });
      } catch {}
      if (body) {
        init.headers = { 'Content-Type': 'application/json' };
        init.body = body;
      }
    }
    const upstream = await fetch(url, init);
    const text = await upstream.text();
    res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
    return res.end(text);
  } catch (e) {
    return sendJson(res, 502, { error: 'upstream_unreachable', detail: e.message });
  }
}

function createLoginChallenge(address) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address || '')) {
    const err = new Error('address must be a 20-byte hex address');
    err.status = 400;
    throw err;
  }
  assertAllowedWallet(address);
  const nonce = randomBytes(16).toString('hex');
  const issuedAt = new Date().toISOString();
  const message = [
    'Paxiom wants to verify control of this wallet.',
    '',
    `Address: ${address}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    '',
    'This signature does not authorize a transaction or payment.',
  ].join('\n');
  // Audit M-19: cap the in-memory nonce map and evict expired entries on
  // each issue to bound memory under nonce-spam from an unauthenticated
  // attacker. 1024 is well above any legitimate concurrency on a single
  // operator UI process.
  const now = Date.now();
  for (const [k, v] of nonces) {
    if (v.expiresAt < now) nonces.delete(k);
  }
  while (nonces.size >= MAX_NONCES) {
    // Drop the oldest entry (insertion-order Map iteration).
    const oldest = nonces.keys().next().value;
    if (oldest === undefined) break;
    nonces.delete(oldest);
  }
  nonces.set(nonce, {
    address: address.toLowerCase(),
    message,
    expiresAt: now + 5 * 60 * 1000,
  });
  return { message, nonce, expiresAt: new Date(now + 5 * 60 * 1000).toISOString() };
}

async function verifyLogin({ address, nonce, signature }) {
  try {
    assertAllowedWallet(address);
  } catch (e) {
    return { ok: false, error: 'wallet_not_allowed' };
  }
  const challenge = nonces.get(nonce);
  if (!challenge) return { ok: false, error: 'unknown_nonce' };
  if (challenge.expiresAt < Date.now()) {
    nonces.delete(nonce);
    return { ok: false, error: 'expired_nonce' };
  }
  if (challenge.address !== String(address || '').toLowerCase()) {
    return { ok: false, error: 'address_mismatch' };
  }
  let valid = false;
  try {
    valid = await verifyMessage({ address, message: challenge.message, signature });
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, error: 'invalid_signature' };

  nonces.delete(nonce);
  const token = randomUUID();
  // Resolved once here for the response. Authorization is re-checked per
  // request against the live roster, so this field is a UI hint, not the
  // thing that grants access.
  const role = roleFor(address);
  const session = {
    token,
    address,
    authenticatedAt: new Date().toISOString(),
    role,
    capabilities: [
      'catalog:read', 'services:probe', 'wallet:x402-ready',
      ...(role === ROLE_ADMIN ? ['wallets:admin'] : []),
    ],
  };
  sessions.set(token, session);
  return { ok: true, session };
}

function assertAllowedWallet(address) {
  if (!isAllowed(address)) {
    const err = new Error('wallet is not allowlisted for this private console');
    err.status = 403;
    throw err;
  }
}

async function checkServices() {
  return Promise.all(SERVICE_HEALTH.map(async (service) => {
    const url = healthUrl(service);
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 900);
    try {
      const resp = await fetch(url, { signal: controller.signal });
      return {
        id: service.id,
        ok: resp.ok,
        status: resp.status,
        url,
        latencyMs: Date.now() - startedAt,
      };
    } catch (e) {
      return {
        id: service.id,
        ok: false,
        status: 0,
        url,
        latencyMs: Date.now() - startedAt,
        error: e.name === 'AbortError' ? 'timeout' : 'offline',
      };
    } finally {
      clearTimeout(timer);
    }
  }));
}

function healthUrl(service) {
  const host = process.env[service.host] || '127.0.0.1';
  const port = Number(process.env[service.port] || service.defaultPort);
  return `http://${host}:${port}/healthz`;
}

function sendHtml(res, html) {
  res.writeHead(200, {
    'Content-Type':  'text/html; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Pragma':        'no-cache',
    'Expires':       '0',
  });
  res.end(html);
}

function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': buf.length,
  });
  res.end(buf);
}

async function readJson(req) {
  return new Promise((resolveRead, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('error', reject);
    req.on('end', () => {
      try {
        resolveRead(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (e) {
        const err = new Error(`invalid json: ${e.message}`);
        err.status = 400;
        reject(err);
      }
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createApp().listen(PORT, HOST, () => {
    console.log(`Paxiom product console running on http://${HOST}:${PORT}`);
  });
}
