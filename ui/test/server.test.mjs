import { test } from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import { createApp } from '../server.js';

// createApp() refuses to start without an env seed (M-18 / #90). Provide a
// default one for the suite; individual tests still override it where the
// allowlist itself is what is under test. Without this the whole file dies at
// the first createApp() call, which is why it had never run.
// Addresses for the two private keys the tests below sign with: 0x..01 and
// 0xbb..bb. Both must be allowlisted or the SIWE flow 403s before signing.
const SEED_ADMIN = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';
const SEED_ADMIN_2 = '0x88f9B82462f6C4bf4a0Fb15e5c3971559a316e7f';
process.env.PAXIOM_ALLOWED_WALLETS ??= `${SEED_ADMIN},${SEED_ADMIN_2}`;

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
    assert.deepEqual(verified.body.session.capabilities,
      ['catalog:read', 'services:probe', 'wallet:x402-ready', 'wallets:admin']);
    assert.equal(verified.body.session.role, 'admin', 'an env-seeded wallet logs in as admin');

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
  ['POST', '/api/arb/test-crosschain-dust'],
  ['POST', '/api/arb/test-half-fill'],
  ['POST', '/api/arb/test-crosschain-loop'],
  ['GET', '/api/arb/funding-quote'],
  ['GET', '/api/arb/operator-rebalance-quote'],
  ['POST', '/api/arb/operator-rebalance'],
];

test('privileged /api/arb routes reject unauthenticated requests', async () => {
  const oldDisable = process.env.PAXIOM_DISABLE_AUTH;
  delete process.env.PAXIOM_DISABLE_AUTH;
  const { server, url } = await listen(createApp());
  try {
    for (const [method, path] of PRIVILEGED_ROUTES) {
      const init = { method, headers: { 'Content-Type': 'application/json' } };
      if (method !== 'GET') init.body = '{}';
      const r = await fetch(`${url}${path}`, init);
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
    const reads = ['/api/arb/scanner-status', '/api/arb/runner-status', '/api/arb/runner-wallet', '/api/arb/runner-performance', '/api/arb/balance-plan', '/api/arb/test-crosschain-dust-status'];
    for (const path of reads) {
      const r = await fetch(`${url}${path}`);
      assert.notEqual(r.status, 401, `${path} should not be 401 — it's read-only`);
    }
  } finally {
    if (oldDisable !== undefined) process.env.PAXIOM_DISABLE_AUTH = oldDisable;
    server.close();
  }
});

// ── #90: wallet administration API ────────────────────────────────────────

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { addWallet, ROLE_MEMBER } from '../wallet-registry.mjs';

// Signs with private key 0xcc..cc. Not in the env seed — it becomes a
// store-managed MEMBER, which is the non-admin case the issue asks about.
const MEMBER_KEY = '0x' + 'c'.repeat(64);
const MEMBER_ADDR = '0xe8acf143AFbF8B1371A20ea934D334180190Eac1';

// Point the ConfigStore at a scratch directory for the duration of `run`.
async function withWalletStore(run) {
  const root = mkdtempSync(pathJoin(tmpdir(), 'paxiom-ui-wallets-'));
  const saved = {
    dir: process.env.PAXIOM_CONFIG_DIR,
    log: process.env.PAXIOM_AUDIT_LOG_DIR,
  };
  process.env.PAXIOM_CONFIG_DIR = pathJoin(root, 'config');
  process.env.PAXIOM_AUDIT_LOG_DIR = pathJoin(root, 'log');
  try {
    return await run();
  } finally {
    if (saved.dir === undefined) delete process.env.PAXIOM_CONFIG_DIR;
    else process.env.PAXIOM_CONFIG_DIR = saved.dir;
    if (saved.log === undefined) delete process.env.PAXIOM_AUDIT_LOG_DIR;
    else process.env.PAXIOM_AUDIT_LOG_DIR = saved.log;
  }
}

async function adminToken(url) {
  return siweLogin(url, privateKeyToAccount('0x' + '0'.repeat(63) + '1'));
}

test('#90: /api/wallets requires authentication', async () => {
  await withWalletStore(async () => {
    const { server, url } = await listen(createApp());
    try {
      const r = await fetch(`${url}/api/wallets`);
      assert.equal(r.status, 401, 'unauthenticated callers get 401, not 403');
    } finally { server.close(); }
  });
});

test('#90: an admin can list, add, promote and remove wallets', async () => {
  await withWalletStore(async () => {
    const { server, url } = await listen(createApp());
    try {
      const token = await adminToken(url);
      const auth = { Authorization: `Bearer ${token}` };

      const listed = await json(url, '/api/wallets', { headers: auth });
      assert.equal(listed.resp.status, 200);
      assert.equal(listed.body.envAdmins.length, 2, 'the two env-seeded admins');
      assert.deepEqual(listed.body.storeAdmins, []);

      const added = await json(url, '/api/wallets', {
        method: 'POST', headers: auth,
        body: JSON.stringify({ address: MEMBER_ADDR, role: 'member', reason: 'onboarding' }),
      });
      assert.equal(added.resp.status, 200);
      assert.deepEqual(added.body.members, [MEMBER_ADDR.toLowerCase()]);

      const promoted = await json(url, `/api/wallets/${MEMBER_ADDR}/role`, {
        method: 'POST', headers: auth, body: JSON.stringify({ role: 'admin' }),
      });
      assert.equal(promoted.resp.status, 200);
      assert.deepEqual(promoted.body.storeAdmins, [MEMBER_ADDR.toLowerCase()]);
      assert.deepEqual(promoted.body.members, []);

      const removed = await fetch(`${url}/api/wallets/${MEMBER_ADDR}`, {
        method: 'DELETE', headers: auth,
      });
      assert.equal(removed.status, 200);
      assert.deepEqual((await removed.json()).storeAdmins, []);
    } finally { server.close(); }
  });
});

test('#90: an env-seeded admin cannot be deleted through the API', async () => {
  await withWalletStore(async () => {
    const { server, url } = await listen(createApp());
    try {
      const token = await adminToken(url);
      const r = await fetch(`${url}/api/wallets/${SEED_ADMIN}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(r.status, 409);
      const body = await r.json();
      assert.equal(body.error, 'conflict');
      assert.match(body.detail, /PAXIOM_ALLOWED_WALLETS/,
        'the refusal tells the operator where the change actually has to happen');
    } finally { server.close(); }
  });
});

test('#90: a member is allowlisted but gets 403 on every mutation', async () => {
  await withWalletStore(async () => {
    const { server, url } = await listen(createApp());
    try {
      // Seed the member directly in the store, then log in as them.
      addWallet({ address: MEMBER_ADDR, role: ROLE_MEMBER, actor: 'test-setup' });
      const memberToken = await siweLogin(url, privateKeyToAccount(MEMBER_KEY));
      assert.ok(memberToken, 'a member can still log in — they are allowlisted');
      const auth = { Authorization: `Bearer ${memberToken}` };

      const listed = await fetch(`${url}/api/wallets`, { headers: auth });
      assert.equal(listed.status, 403, 'reading the roster is admin-only');

      const added = await fetch(`${url}/api/wallets`, {
        method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: '0x' + '9'.repeat(40), role: 'admin' }),
      });
      assert.equal(added.status, 403, 'a member must not be able to promote themselves an ally');

      const removed = await fetch(`${url}/api/wallets/${SEED_ADMIN}`, { method: 'DELETE', headers: auth });
      assert.equal(removed.status, 403);

      const role = await fetch(`${url}/api/wallets/${MEMBER_ADDR}/role`, {
        method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'admin' }),
      });
      assert.equal(role.status, 403, 'a member must not be able to promote themselves');
    } finally { server.close(); }
  });
});

test('#90: a store-managed member logs in with the member role', async () => {
  await withWalletStore(async () => {
    const { server, url } = await listen(createApp());
    try {
      addWallet({ address: MEMBER_ADDR, role: ROLE_MEMBER, actor: 'test-setup' });
      const account = privateKeyToAccount(MEMBER_KEY);
      const challenge = await json(url, '/api/session/nonce', {
        method: 'POST', body: JSON.stringify({ address: account.address }),
      });
      assert.equal(challenge.resp.status, 200, 'a store-managed wallet passes the allowlist gate');
      const signature = await account.signMessage({ message: challenge.body.message });
      const verified = await json(url, '/api/session/verify', {
        method: 'POST',
        body: JSON.stringify({ address: account.address, nonce: challenge.body.nonce, signature }),
      });
      assert.equal(verified.body.session.role, 'member');
      assert.ok(!verified.body.session.capabilities.includes('wallets:admin'));
    } finally { server.close(); }
  });
});

test('#90: a wallet in neither env nor store is still refused', async () => {
  await withWalletStore(async () => {
    const { server, url } = await listen(createApp());
    try {
      const stranger = privateKeyToAccount('0x' + 'd'.repeat(64));
      const r = await json(url, '/api/session/nonce', {
        method: 'POST', body: JSON.stringify({ address: stranger.address }),
      });
      assert.equal(r.resp.status, 403);
    } finally { server.close(); }
  });
});

test('#90: removing a wallet revokes its live session immediately', async () => {
  await withWalletStore(async () => {
    const { server, url } = await listen(createApp());
    try {
      addWallet({ address: MEMBER_ADDR, role: ROLE_MEMBER, actor: 'test-setup' });
      const memberToken = await siweLogin(url, privateKeyToAccount(MEMBER_KEY));
      const auth = { Authorization: `Bearer ${memberToken}` };

      // The member holds a working session on a non-admin privileged route.
      const before = await fetch(`${url}/api/arb/runner-start`, {
        method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}',
      });
      assert.notEqual(before.status, 401, 'session is live to begin with');
      assert.notEqual(before.status, 403);

      // An admin removes them. The token is not touched directly.
      const adminAuth = { Authorization: `Bearer ${await adminToken(url)}` };
      const removed = await fetch(`${url}/api/wallets/${MEMBER_ADDR}`, {
        method: 'DELETE', headers: adminAuth,
      });
      assert.equal(removed.status, 200);

      // The same token must stop working now, not at the next restart.
      const after = await fetch(`${url}/api/arb/runner-start`, {
        method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}',
      });
      assert.equal(after.status, 403, 'removal revokes the live session');
      assert.match((await after.json()).detail, /no longer allowlisted/);
    } finally { server.close(); }
  });
});
