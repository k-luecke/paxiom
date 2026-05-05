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
