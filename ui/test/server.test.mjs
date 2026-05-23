import { test } from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import { createApp } from '../server.js';

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function json(url, path, options = {}) {
  const resp = await fetch(`${url}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await resp.json();
  return { resp, body };
}

test('ui exposes health and the public service catalog', async () => {
  const { server, url } = await listen(createApp());
  try {
    const health = await json(url, '/healthz');
    assert.equal(health.resp.status, 200);
    assert.deepEqual(health.body, { ok: true, service: 'PAXIOM-UI' });

    const catalog = await json(url, '/api/catalog');
    assert.equal(catalog.resp.status, 200);
    assert.deepEqual(catalog.body.services.map((s) => s.id), ['A-201', 'A-202', 'A-203', 'A-204', 'A-205']);
  } finally {
    server.close();
  }
});

test('ui service health probes honor service port environment', async () => {
  const oldPort = process.env.SERVICE_CATALOG_PORT;
  const catalog = await listen(createApp());
  process.env.SERVICE_CATALOG_PORT = String(new URL(catalog.url).port);
  const ui = await listen(createApp());
  try {
    const { resp, body } = await json(ui.url, '/api/services/health');
    assert.equal(resp.status, 200);
    const catalogHealth = body.services.find((s) => s.id === 'CATALOG');
    assert.equal(catalogHealth.ok, true);
    assert.equal(catalogHealth.status, 200);
    assert.match(catalogHealth.url, new RegExp(`:${new URL(catalog.url).port}/healthz$`));
  } finally {
    if (oldPort === undefined) delete process.env.SERVICE_CATALOG_PORT;
    else process.env.SERVICE_CATALOG_PORT = oldPort;
    catalog.server.close();
    ui.server.close();
  }
});

test('ui rejects malformed wallet addresses before creating a nonce', async () => {
  const { server, url } = await listen(createApp());
  try {
    const { resp, body } = await json(url, '/api/session/nonce', {
      method: 'POST',
      body: JSON.stringify({ address: 'not-an-address' }),
    });
    assert.equal(resp.status, 400);
    assert.equal(body.error, 'bad_request');
    assert.match(body.detail, /20-byte hex address/);
  } finally {
    server.close();
  }
});

test('ui rejects wallets outside the private console allowlist', async () => {
  const oldAllowlist = process.env.PAXIOM_ALLOWED_WALLETS;
  process.env.PAXIOM_ALLOWED_WALLETS = '0x0000000000000000000000000000000000000001';
  const { server, url } = await listen(createApp());
  try {
    const { resp, body } = await json(url, '/api/session/nonce', {
      method: 'POST',
      body: JSON.stringify({ address: '0x0000000000000000000000000000000000000002' }),
    });
    assert.equal(resp.status, 403);
    assert.equal(body.error, 'forbidden');
    assert.match(body.detail, /not allowlisted/);
  } finally {
    if (oldAllowlist === undefined) delete process.env.PAXIOM_ALLOWED_WALLETS;
    else process.env.PAXIOM_ALLOWED_WALLETS = oldAllowlist;
    server.close();
  }
});

test('ui verifies a wallet signature and consumes the nonce', async () => {
  const account = privateKeyToAccount('0x0000000000000000000000000000000000000000000000000000000000000001');
  const { server, url } = await listen(createApp());
  try {
    const challenge = await json(url, '/api/session/nonce', {
      method: 'POST',
      body: JSON.stringify({ address: account.address }),
    });
    assert.equal(challenge.resp.status, 200);
    assert.match(challenge.body.message, new RegExp(account.address, 'i'));
    assert.equal(challenge.body.nonce.length, 32);

    const signature = await account.signMessage({ message: challenge.body.message });
    const verified = await json(url, '/api/session/verify', {
      method: 'POST',
      body: JSON.stringify({
        address: account.address,
        nonce: challenge.body.nonce,
        signature,
      }),
    });
    assert.equal(verified.resp.status, 200);
    assert.equal(verified.body.ok, true);
    assert.equal(verified.body.session.address, account.address);
    assert.deepEqual(verified.body.session.capabilities, ['catalog:read', 'services:probe', 'wallet:x402-ready']);

    const replay = await json(url, '/api/session/verify', {
      method: 'POST',
      body: JSON.stringify({
        address: account.address,
        nonce: challenge.body.nonce,
        signature,
      }),
    });
    assert.equal(replay.body.ok, false);
    assert.equal(replay.body.error, 'unknown_nonce');
  } finally {
    server.close();
  }
});

// ─── auth gate on privileged /api/arb/* routes ─────────────────
async function siweLogin(url, account) {
  const challenge = await json(url, '/api/session/nonce', {
    method: 'POST', body: JSON.stringify({ address: account.address }),
  });
  const signature = await account.signMessage({ message: challenge.body.message });
  const verify = await json(url, '/api/session/verify', {
    method: 'POST',
    body: JSON.stringify({ address: account.address, nonce: challenge.body.nonce, signature }),
  });
  return verify.body.session.token;
}

const PRIVILEGED_ROUTES = [
  ['POST', '/api/arb/scanner-start'],
  ['POST', '/api/arb/scanner-stop'],
  ['POST', '/api/arb/runner-start'],
  ['POST', '/api/arb/runner-stop'],
  ['POST', '/api/arb/emergency-close'],
  ['POST', '/api/arb/clear-emergency'],
  ['POST', '/api/arb/withdraw'],
  ['POST', '/api/arb/test-roundtrip'],
  ['POST', '/api/arb/test-half-fill'],
  ['POST', '/api/arb/test-crosschain-loop'],
];

test('privileged /api/arb routes reject unauthenticated requests', async () => {
  const oldDisable = process.env.PAXIOM_DISABLE_AUTH;
  delete process.env.PAXIOM_DISABLE_AUTH;
  const { server, url } = await listen(createApp());
  try {
    for (const [method, path] of PRIVILEGED_ROUTES) {
      const r = await fetch(`${url}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const body = await r.json();
      assert.equal(r.status, 401, `${path} should 401 without session, got ${r.status}`);
      assert.equal(body.error, 'authentication_required');
    }
  } finally {
    if (oldDisable !== undefined) process.env.PAXIOM_DISABLE_AUTH = oldDisable;
    server.close();
  }
});

test('privileged /api/arb routes accept Bearer token from a valid SIWE session', async () => {
  const oldDisable = process.env.PAXIOM_DISABLE_AUTH;
  delete process.env.PAXIOM_DISABLE_AUTH;
  const { server, url } = await listen(createApp());
  const account = privateKeyToAccount('0x' + 'b'.repeat(64));
  try {
    const token = await siweLogin(url, account);
    // Hit a privileged route — auth should pass; we expect a 502 because the
    // upstream runner isn't running in this test, NOT a 401.
    const r = await fetch(`${url}/api/arb/runner-start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ tradeSizeUsd: 500 }),
    });
    // Auth gate let the request through — anything other than 401 means the
    // proxy reached the upstream (or upstream is down → 502). Don't pin to a
    // specific status code; the runner state varies based on environment.
    assert.notEqual(r.status, 401, 'auth should pass for valid token');
  } finally {
    if (oldDisable !== undefined) process.env.PAXIOM_DISABLE_AUTH = oldDisable;
    server.close();
  }
});

test('PAXIOM_DISABLE_AUTH=1 bypasses the auth gate (for local-dev convenience)', async () => {
  const old = process.env.PAXIOM_DISABLE_AUTH;
  process.env.PAXIOM_DISABLE_AUTH = '1';
  const { server, url } = await listen(createApp());
  try {
    const r = await fetch(`${url}/api/arb/runner-start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    // Should NOT be 401 — bypass active. Will be 502 because upstream runner isn't up.
    assert.notEqual(r.status, 401);
  } finally {
    if (old === undefined) delete process.env.PAXIOM_DISABLE_AUTH;
    else process.env.PAXIOM_DISABLE_AUTH = old;
    server.close();
  }
});

test('GET /api/arb routes do NOT require auth (read-only by design)', async () => {
  const oldDisable = process.env.PAXIOM_DISABLE_AUTH;
  delete process.env.PAXIOM_DISABLE_AUTH;
  const { server, url } = await listen(createApp());
  try {
    // Read-only routes should reach the proxy (502 since upstream is down).
    // Critically they should NOT be 401.
    const reads = ['/api/arb/scanner-status', '/api/arb/runner-status', '/api/arb/runner-wallet', '/api/arb/runner-performance', '/api/arb/balance-plan'];
    for (const path of reads) {
      const r = await fetch(`${url}${path}`);
      assert.notEqual(r.status, 401, `${path} should not be 401 — it's read-only`);
    }
  } finally {
    if (oldDisable !== undefined) process.env.PAXIOM_DISABLE_AUTH = oldDisable;
    server.close();
  }
});
