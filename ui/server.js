import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { verifyMessage } from 'viem';
import { phase1Catalog } from '../services/catalog/phase1.mjs';

const PORT = Number(process.env.PAXIOM_UI_PORT || 3000);
const HOST = process.env.PAXIOM_UI_HOST || '127.0.0.1';
const here = dirname(fileURLToPath(import.meta.url));

const sessions = new Map();
const nonces = new Map();

const SERVICE_HEALTH = [
  { id: 'CATALOG', url: 'http://127.0.0.1:8090/healthz' },
  { id: 'A-201', url: 'http://127.0.0.1:8091/healthz' },
  { id: 'A-202', url: 'http://127.0.0.1:8080/healthz' },
  { id: 'A-203', url: 'http://127.0.0.1:8093/healthz' },
  { id: 'A-204', url: 'http://127.0.0.1:8094/healthz' },
  { id: 'A-205', url: 'http://127.0.0.1:8095/healthz' },
  { id: 'COMPLIANCE-001', url: 'http://127.0.0.1:8083/healthz' },
];

export function createApp() {
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
      if (req.method === 'GET' && url.pathname === '/healthz') {
        return sendJson(res, 200, { ok: true, service: 'PAXIOM-UI' });
      }
      res.writeHead(404);
      return res.end();
    } catch (e) {
      const status = Number.isInteger(e.status) ? e.status : 500;
      const error = status === 403 ? 'forbidden' : status === 500 ? 'ui_server_error' : 'bad_request';
      return sendJson(res, status, { error, detail: e.message });
    }
  });
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
  nonces.set(nonce, {
    address: address.toLowerCase(),
    message,
    expiresAt: Date.now() + 5 * 60 * 1000,
  });
  return { message, nonce, expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString() };
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
  const session = {
    token,
    address,
    authenticatedAt: new Date().toISOString(),
    capabilities: ['catalog:read', 'services:probe', 'wallet:x402-ready'],
  };
  sessions.set(token, session);
  return { ok: true, session };
}

function assertAllowedWallet(address) {
  const allowed = allowedWallets();
  if (allowed.size === 0) return;
  if (!allowed.has(String(address || '').toLowerCase())) {
    const err = new Error('wallet is not allowlisted for this private console');
    err.status = 403;
    throw err;
  }
}

function allowedWallets() {
  return new Set(String(process.env.PAXIOM_ALLOWED_WALLETS || '')
    .split(',')
    .map((wallet) => wallet.trim().toLowerCase())
    .filter(Boolean));
}

async function checkServices() {
  return Promise.all(SERVICE_HEALTH.map(async (service) => {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 900);
    try {
      const resp = await fetch(service.url, { signal: controller.signal });
      return {
        id: service.id,
        ok: resp.ok,
        status: resp.status,
        latencyMs: Date.now() - startedAt,
      };
    } catch (e) {
      return {
        id: service.id,
        ok: false,
        status: 0,
        latencyMs: Date.now() - startedAt,
        error: e.name === 'AbortError' ? 'timeout' : 'offline',
      };
    } finally {
      clearTimeout(timer);
    }
  }));
}

function sendHtml(res, html) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
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
