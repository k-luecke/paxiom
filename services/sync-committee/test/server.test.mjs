// Fixture-driven test for the sync-committee HTTP service.
// Forces MOCK_DEVICE=1 so dispatch is deterministic; asserts the response
// shape matches O-701 / S.02 and the validator catches bad input.
//
// Mock dispatch is fail-closed: payload.verified=false and payload.mock=true
// so downstream consumers cannot mistake synthetic responses for real BLS
// verifications.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';

process.env.MOCK_DEVICE = '1';
process.env.PAXIOM_ALLOW_MOCK = '1';

function listenOnEphemeralPort(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

const wellFormedRequest = {
  slot: '8421337',
  block_root: '0x' + 'a'.repeat(64),
  parent_root: '0x' + 'b'.repeat(64),
  sync_aggregate: {
    sync_committee_bits: '0x' + 'ff'.repeat(64),
    sync_committee_signature: '0x' + 'c'.repeat(192),
  },
};

test('healthz returns ok', async () => {
  const { server, url } = await listenOnEphemeralPort(createApp());
  try {
    const resp = await fetch(`${url}/healthz`);
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.deepEqual(body, { ok: true, service: 'A-202' });
  } finally {
    server.close();
  }
});

test('verify with mock dispatch returns signed A-202 artifact envelope', async () => {
  const { server, url } = await listenOnEphemeralPort(createApp());
  try {
    const resp = await fetch(`${url}/v1/sync-committee/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(wellFormedRequest),
    });
    assert.equal(resp.status, 200);
    const body = await resp.json();

    assert.equal(body.service, 'A-202');
    assert.equal(body.artifact.type, 'sync_committee_verification');
    assert.match(body.platformSignature.responseHash, /^0x[0-9a-f]{64}$/);
    assert.equal(body.auditRecord.aoMessageId.startsWith('mock-ao-'), true);

    const payload = body.artifact.payload;
    // Required fields per O-701 / S.02.
    for (const field of [
      'verified', 'service', 'slot', 'fork_version', 'domain', 'signing_root',
      'participating', 'committee_size', 'primitive_return_code',
      'platform_signature', 'ao_message_id',
    ]) {
      assert.ok(field in payload, `missing field: ${field}`);
    }
    assert.equal(payload.service, 'A-202');
    assert.equal(payload.slot, '8421337');
    assert.match(payload.fork_version, /^0x[0-9a-f]{8}$/);
    assert.match(payload.signing_root, /^0x[0-9a-f]{64}$/);
    // Mock dispatch is fail-closed: no real BLS verification ran.
    assert.equal(payload.verified, false);
    assert.equal(payload.mock, true);
    assert.equal(payload.committee_size, 0);
    assert.equal(payload.participating, 0);
    assert.equal(payload.primitive_return_code, -1);
    assert.ok(resp.headers.get('x-payment-response-correlation'));
  } finally {
    server.close();
  }
});

test('verify rejects malformed signature length', async () => {
  const { server, url } = await listenOnEphemeralPort(createApp());
  try {
    const bad = JSON.parse(JSON.stringify(wellFormedRequest));
    bad.sync_aggregate.sync_committee_signature = '0xdead';
    const resp = await fetch(`${url}/v1/sync-committee/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bad),
    });
    assert.equal(resp.status, 400);
    const body = await resp.json();
    assert.equal(body.error, 'invalid request');
  } finally {
    server.close();
  }
});

test('verify rejects non-POST methods', async () => {
  const { server, url } = await listenOnEphemeralPort(createApp());
  try {
    const resp = await fetch(`${url}/v1/sync-committee/verify`);
    assert.equal(resp.status, 405);
    assert.equal(resp.headers.get('allow'), 'POST');
  } finally {
    server.close();
  }
});

test('verify returns x402 payment requirement when enabled', async () => {
  const oldRequire = process.env.REQUIRE_X402;
  process.env.REQUIRE_X402 = '1';
  const { server, url } = await listenOnEphemeralPort(createApp());
  try {
    const resp = await fetch(`${url}/v1/sync-committee/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(wellFormedRequest),
    });
    assert.equal(resp.status, 402);
    assert.ok(resp.headers.get('payment-required'));
  } finally {
    process.env.REQUIRE_X402 = oldRequire;
    server.close();
  }
});
