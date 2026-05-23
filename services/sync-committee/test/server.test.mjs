// Fixture-driven test for the sync-committee HTTP service.
// Forces MOCK_DEVICE=1 so dispatch is deterministic; asserts the response
// shape matches O-701 / S.02 and the validator catches bad input.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../server.mjs';

process.env.MOCK_DEVICE = '1';

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
    assert.equal(payload.committee_size, 512);
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

test('verify rejects device responses for a different slot', async () => {
  const oldMock = process.env.MOCK_DEVICE;
  const oldViaSubprocess = process.env.BLS_DEVICE_VIA_SUBPROCESS;
  const oldDispatch = process.env.HYPERBEAM_DISPATCH_URL;
  delete process.env.MOCK_DEVICE;
  delete process.env.BLS_DEVICE_VIA_SUBPROCESS;

  const upstream = await listenOnEphemeralPort(createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const requested = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const payload = {
      verified: true,
      service: 'A-202',
      slot: String(Number(requested.slot) + 1),
      fork_version: '0x06000000',
      domain: '0x' + 'a'.repeat(64),
      signing_root: '0x' + 'b'.repeat(64),
      participating: 432,
      committee_size: 512,
      primitive_return_code: 1,
      platform_signature: '0x' + 'c'.repeat(64),
      ao_message_id: `fake-ao-${requested.slot}`,
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  }));
  process.env.HYPERBEAM_DISPATCH_URL = `${upstream.url}/verify`;

  const app = await listenOnEphemeralPort(createApp());
  try {
    const resp = await fetch(`${app.url}/v1/sync-committee/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(wellFormedRequest),
    });
    assert.equal(resp.status, 502);
    const body = await resp.json();
    assert.equal(body.error, 'dispatch failed');
    assert.match(body.detail, /device response slot mismatch/);
    assert.match(body.detail, /request\.slot=8421337 response\.slot=8421338/);
  } finally {
    if (oldMock === undefined) delete process.env.MOCK_DEVICE;
    else process.env.MOCK_DEVICE = oldMock;
    if (oldViaSubprocess === undefined) delete process.env.BLS_DEVICE_VIA_SUBPROCESS;
    else process.env.BLS_DEVICE_VIA_SUBPROCESS = oldViaSubprocess;
    if (oldDispatch === undefined) delete process.env.HYPERBEAM_DISPATCH_URL;
    else process.env.HYPERBEAM_DISPATCH_URL = oldDispatch;
    app.server.close();
    upstream.server.close();
  }
});

test('verify accepts HyperBEAM responses wrapped in a body string', async () => {
  const oldMock = process.env.MOCK_DEVICE;
  const oldViaSubprocess = process.env.BLS_DEVICE_VIA_SUBPROCESS;
  const oldDispatch = process.env.HYPERBEAM_DISPATCH_URL;
  delete process.env.MOCK_DEVICE;
  delete process.env.BLS_DEVICE_VIA_SUBPROCESS;

  const upstream = await listenOnEphemeralPort(createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const requested = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const payload = {
      verified: false,
      service: 'A-202',
      slot: requested.slot,
      fork_version: '0x06000000',
      domain: '0x' + 'a'.repeat(64),
      signing_root: '0x' + 'b'.repeat(64),
      participating: 0,
      committee_size: 512,
      primitive_return_code: -5,
      platform_signature: '0x' + 'c'.repeat(64),
      ao_message_id: `hb-ao-${requested.slot}`,
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 200, body: JSON.stringify(payload) }));
  }));
  process.env.HYPERBEAM_DISPATCH_URL = `${upstream.url}/verify`;

  const app = await listenOnEphemeralPort(createApp());
  try {
    const resp = await fetch(`${app.url}/v1/sync-committee/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(wellFormedRequest),
    });
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.artifact.payload.slot, wellFormedRequest.slot);
    assert.equal(body.auditRecord.aoMessageId, `hb-ao-${wellFormedRequest.slot}`);
  } finally {
    if (oldMock === undefined) delete process.env.MOCK_DEVICE;
    else process.env.MOCK_DEVICE = oldMock;
    if (oldViaSubprocess === undefined) delete process.env.BLS_DEVICE_VIA_SUBPROCESS;
    else process.env.BLS_DEVICE_VIA_SUBPROCESS = oldViaSubprocess;
    if (oldDispatch === undefined) delete process.env.HYPERBEAM_DISPATCH_URL;
    else process.env.HYPERBEAM_DISPATCH_URL = oldDispatch;
    app.server.close();
    upstream.server.close();
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
