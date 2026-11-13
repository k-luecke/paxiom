// Fixture-driven test for the sync-committee HTTP service.
// Forces MOCK_DEVICE=1 so dispatch is deterministic; asserts the response
// shape matches O-701 / S.02 and the validator catches bad input.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createPublicKey } from 'node:crypto';
import { createApp } from '../server.mjs';
import { classifyDispatchOutcome } from '../x402-gate.mjs';
import {
  verifyPayloadSignature,
} from '../platform-signature.mjs';
import { receiptCacheKey } from '../payment-receipts.mjs';

process.env.MOCK_DEVICE = '1';
process.env.DISABLE_SYNC_COMMITTEE_EVIDENCE = '1';

function createPublicKeyFromSpkiBase64(publicKeyBase64) {
  return createPublicKey({
    key: Buffer.from(publicKeyBase64, 'base64'),
    format: 'der',
    type: 'spki',
  });
}

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

function validResponse(overrides = {}) {
  return {
    verified: true,
    service: 'A-202',
    slot: '8421337',
    fork_version: '0x06000000',
    domain: '0x' + 'a'.repeat(64),
    signing_root: '0x' + 'b'.repeat(64),
    participating: 432,
    committee_size: 512,
    primitive_return_code: 1,
    platform_signature: '0x' + 'c'.repeat(64),
    ao_message_id: 'ao-test',
    ...overrides,
  };
}

function paymentSignatureHeader() {
  const payload = {
    x402Version: 2,
    accepted: {
      scheme: 'exact',
      network: 'eip155:84532',
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      amount: '1000',
      payTo: '0x0000000000000000000000000000000000000001',
      maxTimeoutSeconds: 120,
      extra: { name: 'USDC', version: '2' },
    },
    payload: { authorization: { from: '0x0000000000000000000000000000000000000002' } },
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

const fakeFacilitatorClient = {
  async getSupported() {
    return {
      kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:84532' }],
      extensions: [],
      signers: {},
    };
  },
  async verify() {
    throw new Error('verify should not be called without a payment header');
  },
  async settle() {
    throw new Error('settle should not be called without a payment header');
  },
};

const settlingFacilitatorClient = {
  async getSupported() {
    return fakeFacilitatorClient.getSupported();
  },
  async verify() {
    return { isValid: true, payer: '0x0000000000000000000000000000000000000002' };
  },
  async settle() {
    return {
      success: true,
      transaction: '0x' + 'd'.repeat(64),
      network: 'eip155:84532',
      payer: '0x0000000000000000000000000000000000000002',
    };
  },
};

const rejectingFacilitatorClient = {
  async getSupported() {
    return fakeFacilitatorClient.getSupported();
  },
  async verify() {
    return { isValid: false, invalidReason: 'invalid test payment' };
  },
  async settle() {
    throw new Error('settle should not be called after failed verify');
  },
};

const failingSettlementClient = {
  async getSupported() {
    return fakeFacilitatorClient.getSupported();
  },
  async verify() {
    return { isValid: true, payer: '0x0000000000000000000000000000000000000002' };
  },
  async settle() {
    return {
      success: false,
      transaction: '',
      network: 'eip155:84532',
      payer: '0x0000000000000000000000000000000000000002',
      errorReason: 'settlement failed in test',
    };
  },
};

test('healthz returns ok', async () => {
  const { server, url } = await listenOnEphemeralPort(createApp());
  try {
    const resp = await fetch(`${url}/healthz`);
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.ok, true);
    assert.equal(body.service, 'A-202');
    assert.equal(body.dispatch, 'mock');
    assert.deepEqual(body.x402, {
      enabled: false,
      mode: 'testnet',
      network: 'eip155:84532',
      price: '$0.001',
      node_supported_for_production: false,
    });
    assert.equal(body.platform_signer.alg, 'ed25519');
  } finally {
    server.close();
  }
});

test('verify with mock dispatch returns S.02-shaped response', async () => {
  const { server, url } = await listenOnEphemeralPort(createApp());
  try {
    const resp = await fetch(`${url}/v1/sync-committee/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(wellFormedRequest),
    });
    assert.equal(resp.status, 200);
    const body = await resp.json();

    // Required fields per O-701 / S.02.
    for (const field of [
      'verified', 'service', 'slot', 'fork_version', 'domain', 'signing_root',
      'participating', 'committee_size', 'primitive_return_code',
      'platform_signature', 'ao_message_id',
    ]) {
      assert.ok(field in body, `missing field: ${field}`);
    }
    assert.equal(body.service, 'A-202');
    assert.equal(body.slot, '8421337');
    assert.match(body.fork_version, /^0x[0-9a-f]{8}$/);
    assert.match(body.signing_root, /^0x[0-9a-f]{64}$/);
    assert.equal(body.committee_size, 512);
    assert.ok(resp.headers.get('x-paxiom-response-correlation'));
    assert.ok(resp.headers.get('x-paxiom-signature'));
    assert.ok(resp.headers.get('x-paxiom-signed-payload-hash'));
    assert.ok(body.signed_payload);
  } finally {
    server.close();
  }
});

test('platform signature round-trips from response body and well-known key', async () => {
  const { server, url } = await listenOnEphemeralPort(createApp());
  try {
    const resp = await fetch(`${url}/v1/sync-committee/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(wellFormedRequest),
    });
    assert.equal(resp.status, 200);
    const body = await resp.json();
    const keyResp = await fetch(`${url}/.well-known/paxiom-platform-pubkey.json`);
    const keyDoc = await keyResp.json();
    assert.equal(keyDoc.alg, 'ed25519');
    assert.equal(verifyPayloadSignature({
      publicKey: createPublicKeyFromSpkiBase64(keyDoc.public_key),
      payload: body.signed_payload,
      signatureBase64: body.platform_signature,
    }), true);
  } finally {
    server.close();
  }
});

test('mcp metadata exposes the paid tool shape without requiring payment', async () => {
  const { server, url } = await listenOnEphemeralPort(createApp());
  try {
    const toolsResp = await fetch(`${url}/mcp/tools.json`);
    assert.equal(toolsResp.status, 200);
    const toolsBody = await toolsResp.json();
    assert.equal(toolsBody.tools.length, 1);
    assert.equal(toolsBody.tools[0].name, 'paxiom.sync_committee.verify');

    const resp = await fetch(`${url}/mcp/paxiom-sync-committee.json`);
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.name, 'paxiom.sync_committee.verify');
    assert.equal(body.payment.protocol, 'x402');
    assert.equal(body.payment.price, '$0.001');
    assert.equal(body.run_modes.mock_device_billable, false);
    assert.equal(body.input_schema.required.includes('sync_aggregate'), true);
  } finally {
    server.close();
  }
});

test('x402 runtime refuses to charge mock-device output', async () => {
  assert.throws(
    () => createApp({
      env: {
        ...process.env,
        REQUIRE_X402: '1',
        MOCK_DEVICE: '1',
        X402_PAY_TO: '0x0000000000000000000000000000000000000001',
      },
    }),
    /never charge for MOCK_DEVICE/,
  );
});

test('x402 runtime refuses paid mode without a configured platform key', async () => {
  assert.throws(
    () => createApp({
      env: {
        ...process.env,
        REQUIRE_X402: '1',
        MOCK_DEVICE: '',
        X402_PAY_TO: '0x0000000000000000000000000000000000000001',
      },
    }),
    /requires PAXIOM_PLATFORM_SIGNING_KEY/,
  );
});

test('x402 route returns 402 before dispatch when no payment header is present', async () => {
  const env = {
    ...process.env,
    REQUIRE_X402: '1',
    MOCK_DEVICE: '',
    X402_PAY_TO: '0x0000000000000000000000000000000000000001',
    DISABLE_SYNC_COMMITTEE_EVIDENCE: '1',
    PAXIOM_ALLOW_EPHEMERAL_PLATFORM_KEY: '1',
  };
  const { server, url } = await listenOnEphemeralPort(createApp({ env, facilitatorClient: fakeFacilitatorClient }));
  try {
    const resp = await fetch(`${url}/v1/sync-committee/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(wellFormedRequest),
    });
    assert.equal(resp.status, 402);
    assert.ok(resp.headers.get('payment-required') || resp.headers.get('x-payment-required'));
    const body = await resp.json();
    assert.equal(body.error, 'payment_required');
    assert.equal(body.price, '$0.001');
    assert.equal(body.network, 'eip155:84532');
  } finally {
    server.close();
  }
});

test('paid route returns 402 and does not dispatch when facilitator verify fails', async () => {
  const env = {
    ...process.env,
    REQUIRE_X402: '1',
    MOCK_DEVICE: '',
    X402_PAY_TO: '0x0000000000000000000000000000000000000001',
    DISABLE_SYNC_COMMITTEE_EVIDENCE: '1',
    PAXIOM_ALLOW_EPHEMERAL_PLATFORM_KEY: '1',
  };
  let dispatched = false;
  const { server, url } = await listenOnEphemeralPort(createApp({
    env,
    facilitatorClient: rejectingFacilitatorClient,
    dispatch: async () => {
      dispatched = true;
      return validResponse();
    },
  }));
  try {
    const resp = await fetch(`${url}/v1/sync-committee/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'PAYMENT-SIGNATURE': paymentSignatureHeader(),
      },
      body: JSON.stringify(wellFormedRequest),
    });
    assert.equal(resp.status, 402);
    assert.equal(dispatched, false);
  } finally {
    server.close();
  }
});

test('paid route settles verified:false answers with valid signing root', async () => {
  const env = {
    ...process.env,
    REQUIRE_X402: '1',
    MOCK_DEVICE: '',
    X402_PAY_TO: '0x0000000000000000000000000000000000000001',
    DISABLE_SYNC_COMMITTEE_EVIDENCE: '1',
    PAXIOM_ALLOW_EPHEMERAL_PLATFORM_KEY: '1',
  };
  const { server, url } = await listenOnEphemeralPort(createApp({
    env,
    facilitatorClient: settlingFacilitatorClient,
    dispatch: async () => validResponse({ verified: false, primitive_return_code: 0 }),
  }));
  try {
    const resp = await fetch(`${url}/v1/sync-committee/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'PAYMENT-SIGNATURE': paymentSignatureHeader(),
      },
      body: JSON.stringify(wellFormedRequest),
    });
    assert.equal(resp.status, 200);
    assert.ok(resp.headers.get('payment-response'));
    const body = await resp.json();
    assert.equal(body.verified, false);
  } finally {
    server.close();
  }
});

test('paid route does not settle structurally invalid verifier output', async () => {
  const env = {
    ...process.env,
    REQUIRE_X402: '1',
    MOCK_DEVICE: '',
    X402_PAY_TO: '0x0000000000000000000000000000000000000001',
    DISABLE_SYNC_COMMITTEE_EVIDENCE: '1',
    PAXIOM_ALLOW_EPHEMERAL_PLATFORM_KEY: '1',
  };
  let settled = false;
  const { server, url } = await listenOnEphemeralPort(createApp({
    env,
    facilitatorClient: { ...settlingFacilitatorClient, settle: async () => { settled = true; return settlingFacilitatorClient.settle(); } },
    dispatch: async () => validResponse({ verified: false, signing_root: null }),
  }));
  try {
    const resp = await fetch(`${url}/v1/sync-committee/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'PAYMENT-SIGNATURE': paymentSignatureHeader(),
      },
      body: JSON.stringify(wellFormedRequest),
    });
    assert.equal(resp.status, 400);
    assert.equal(settled, false);
  } finally {
    server.close();
  }
});

test('paid route drops premium body and returns 502 when settlement fails', async () => {
  const env = {
    ...process.env,
    REQUIRE_X402: '1',
    MOCK_DEVICE: '',
    X402_PAY_TO: '0x0000000000000000000000000000000000000001',
    DISABLE_SYNC_COMMITTEE_EVIDENCE: '1',
    PAXIOM_ALLOW_EPHEMERAL_PLATFORM_KEY: '1',
  };
  const { server, url } = await listenOnEphemeralPort(createApp({
    env,
    facilitatorClient: failingSettlementClient,
    dispatch: async () => validResponse(),
  }));
  try {
    const resp = await fetch(`${url}/v1/sync-committee/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'PAYMENT-SIGNATURE': paymentSignatureHeader(),
      },
      body: JSON.stringify(wellFormedRequest),
    });
    assert.equal(resp.status, 502);
    const body = await resp.json();
    assert.equal(body.error, 'settlement_failed');
    assert.equal('verified' in body, false);
  } finally {
    server.close();
  }
});

test('dispatch exceptions return 502 before settlement', async () => {
  const env = {
    ...process.env,
    REQUIRE_X402: '1',
    MOCK_DEVICE: '',
    X402_PAY_TO: '0x0000000000000000000000000000000000000001',
    DISABLE_SYNC_COMMITTEE_EVIDENCE: '1',
    PAXIOM_ALLOW_EPHEMERAL_PLATFORM_KEY: '1',
  };
  let settled = false;
  const { server, url } = await listenOnEphemeralPort(createApp({
    env,
    facilitatorClient: {
      ...settlingFacilitatorClient,
      settle: async () => {
        settled = true;
        return settlingFacilitatorClient.settle();
      },
    },
    dispatch: async () => {
      throw new Error('synthetic dispatch outage');
    },
  }));
  try {
    const resp = await fetch(`${url}/v1/sync-committee/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'PAYMENT-SIGNATURE': paymentSignatureHeader(),
      },
      body: JSON.stringify(wellFormedRequest),
    });
    assert.equal(resp.status, 502);
    assert.equal(settled, false);
  } finally {
    server.close();
  }
});

test('classifyDispatchOutcome covers the settlement boundary table', () => {
  assert.deepEqual(classifyDispatchOutcome(validResponse()).settle, true);
  assert.deepEqual(classifyDispatchOutcome(validResponse({ verified: false })).settle, true);
  assert.equal(classifyDispatchOutcome(validResponse({ verified: false, error_class: 'structural_invalid' })).httpStatus, 400);
  assert.equal(classifyDispatchOutcome(null).httpStatus, 502);
  assert.equal(classifyDispatchOutcome(validResponse({ verified: false, signing_root: '0xdead' })).httpStatus, 400);
});

test('receipt cache key uses payment payload hash only', () => {
  const paymentPayloadA = { payment: 'a', nonce: '1' };
  const paymentPayloadB = { payment: 'b', nonce: '2' };
  assert.equal(
    receiptCacheKey({ requestHash: 'same-request', paymentPayload: paymentPayloadA }),
    receiptCacheKey({ requestHash: 'different-request', paymentPayload: paymentPayloadA }),
  );
  assert.notEqual(
    receiptCacheKey({ requestHash: 'same-request', paymentPayload: paymentPayloadA }),
    receiptCacheKey({ requestHash: 'same-request', paymentPayload: paymentPayloadB }),
  );
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
