import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServiceEnvelope } from '../envelope.mjs';
import { preflightService } from '../preflight.mjs';
import { encodeHeader, requirePayment } from '../x402.mjs';

function snapshotEnv(keys) {
  const saved = new Map();
  for (const key of keys) saved.set(key, process.env[key]);
  return () => {
    for (const [key, value] of saved.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function fakeResponse() {
  return {
    status: null,
    headers: null,
    body: '',
    writeHead(status, headers = {}) {
      this.status = status;
      this.headers = headers;
    },
    end(body = '') {
      this.body = body;
    },
  };
}

test('disabled x402 does not claim payment verification or settlement', async () => {
  const restore = snapshotEnv(['REQUIRE_X402']);
  delete process.env.REQUIRE_X402;
  try {
    const result = await requirePayment({ headers: {}, url: '/v1/test' }, fakeResponse(), {
      service: 'A-202',
      resource: '/v1/test',
    });
    assert.equal(result.ok, true);
    assert.equal(result.payment.mode, 'disabled');
    assert.equal(result.payment.verified, false);
    assert.equal(result.payment.settled, false);
    assert.equal(result.payment.settlementRequired, false);
  } finally {
    restore();
  }
});

test('local-header x402 verifier is opt-in development only', async () => {
  const restore = snapshotEnv([
    'PAXIOM_ALLOW_LOCAL_X402',
    'PAXIOM_DEPLOYMENT_MODE',
    'PAXIOM_ENV',
    'REQUIRE_X402',
    'X402_FACILITATOR_URL',
  ]);
  process.env.REQUIRE_X402 = '1';
  delete process.env.X402_FACILITATOR_URL;
  delete process.env.PAXIOM_ALLOW_LOCAL_X402;
  delete process.env.PAXIOM_DEPLOYMENT_MODE;
  delete process.env.PAXIOM_ENV;

  try {
    const res = fakeResponse();
    const result = await requirePayment({
      headers: { 'x-payment': encodeHeader({ payer: 'local-dev' }) },
      url: '/v1/test',
    }, res, {
      service: 'A-202',
      resource: '/v1/test',
    });
    assert.equal(result.ok, false);
    assert.equal(res.status, 503);

    process.env.PAXIOM_ALLOW_LOCAL_X402 = '1';
    const allowed = await requirePayment({
      headers: { 'x-payment': encodeHeader({ payer: 'local-dev' }) },
      url: '/v1/test',
    }, fakeResponse(), {
      service: 'A-202',
      resource: '/v1/test',
    });
    assert.equal(allowed.ok, true);
    assert.equal(allowed.payment.mode, 'local-header');
    assert.equal(allowed.payment.verified, false);
    assert.equal(allowed.payment.settled, false);

    process.env.PAXIOM_DEPLOYMENT_MODE = 'testnet';
    const strictRes = fakeResponse();
    const strict = await requirePayment({
      headers: { 'x-payment': encodeHeader({ payer: 'local-dev' }) },
      url: '/v1/test',
    }, strictRes, {
      service: 'A-202',
      resource: '/v1/test',
    });
    assert.equal(strict.ok, false);
    assert.equal(strictRes.status, 503);
  } finally {
    restore();
  }
});

test('strict deployment mode refuses dev response signatures', () => {
  const restore = snapshotEnv([
    'PAXIOM_DEPLOYMENT_MODE',
    'PAXIOM_ENV',
    'PAXIOM_RESPONSE_SIGNING_PRIVATE_KEY_PEM',
    'PAXIOM_RESPONSE_SIGNING_KEY_ID',
  ]);
  process.env.PAXIOM_DEPLOYMENT_MODE = 'testnet';
  delete process.env.PAXIOM_ENV;
  delete process.env.PAXIOM_RESPONSE_SIGNING_PRIVATE_KEY_PEM;
  delete process.env.PAXIOM_RESPONSE_SIGNING_KEY_ID;

  try {
    assert.throws(() => createServiceEnvelope({
      service: 'A-202',
      serviceName: 'Sync Committee Verification',
      artifactType: 'test',
      payload: { verified: false },
      payment: { mode: 'disabled', verified: false },
    }), /PAXIOM_RESPONSE_SIGNING_PRIVATE_KEY_PEM is required in testnet mode/);
  } finally {
    restore();
  }
});

test('strict preflight rejects mocks and unsigned response envelopes', () => {
  const restore = snapshotEnv([
    'MOCK_DEVICE',
    'PAXIOM_DEPLOYMENT_MODE',
    'PAXIOM_ENV',
    'PAXIOM_RESPONSE_SIGNING_PRIVATE_KEY_PEM',
    'PAXIOM_RESPONSE_SIGNING_KEY_ID',
    'REQUIRE_X402',
  ]);
  process.env.PAXIOM_DEPLOYMENT_MODE = 'testnet';
  process.env.MOCK_DEVICE = '1';
  process.env.REQUIRE_X402 = '0';
  delete process.env.PAXIOM_ENV;
  delete process.env.PAXIOM_RESPONSE_SIGNING_PRIVATE_KEY_PEM;
  delete process.env.PAXIOM_RESPONSE_SIGNING_KEY_ID;

  try {
    const result = preflightService('sync-committee');
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('MOCK_DEVICE=1 is not allowed')));
    assert.ok(result.errors.some((e) => e.includes('PAXIOM_RESPONSE_SIGNING_PRIVATE_KEY_PEM is required')));
  } finally {
    restore();
  }
});

test('strict preflight requires opt-in for reference-only services', () => {
  const restore = snapshotEnv([
    'PAXIOM_ALLOW_REFERENCE_SERVICES',
    'PAXIOM_DEPLOYMENT_MODE',
    'PAXIOM_ENV',
    'PAXIOM_RESPONSE_SIGNING_PRIVATE_KEY_PEM',
    'PAXIOM_RESPONSE_SIGNING_KEY_ID',
    'REQUIRE_X402',
  ]);
  process.env.PAXIOM_DEPLOYMENT_MODE = 'testnet';
  process.env.PAXIOM_RESPONSE_SIGNING_PRIVATE_KEY_PEM = 'placeholder';
  process.env.PAXIOM_RESPONSE_SIGNING_KEY_ID = 'test-key';
  process.env.REQUIRE_X402 = '0';
  delete process.env.PAXIOM_ALLOW_REFERENCE_SERVICES;
  delete process.env.PAXIOM_ENV;

  try {
    const blocked = preflightService('simulation');
    assert.equal(blocked.ok, false);
    assert.ok(blocked.errors.some((e) => e.includes('A-204 still emits deterministic reference receipts')));

    process.env.PAXIOM_ALLOW_REFERENCE_SERVICES = '1';
    const allowed = preflightService('simulation');
    assert.equal(allowed.ok, true);
    assert.ok(allowed.warnings.some((e) => e.includes('REQUIRE_X402 is not enabled')));
  } finally {
    restore();
  }
});

test('strict preflight requires proof archive for state-proof services', () => {
  const restore = snapshotEnv([
    'PAXIOM_DEPLOYMENT_MODE',
    'PAXIOM_ENV',
    'PAXIOM_RESPONSE_SIGNING_PRIVATE_KEY_PEM',
    'PAXIOM_RESPONSE_SIGNING_KEY_ID',
    'PAXIOM_PROOF_ARCHIVE_MODE',
    'PAXIOM_PROOF_ARCHIVE_ENCRYPTION_KEY_BASE64',
    'REQUIRE_X402',
  ]);
  process.env.PAXIOM_DEPLOYMENT_MODE = 'testnet';
  process.env.PAXIOM_RESPONSE_SIGNING_PRIVATE_KEY_PEM = 'placeholder';
  process.env.PAXIOM_RESPONSE_SIGNING_KEY_ID = 'test-key';
  process.env.REQUIRE_X402 = '0';
  delete process.env.PAXIOM_ENV;
  delete process.env.PAXIOM_PROOF_ARCHIVE_MODE;
  delete process.env.PAXIOM_PROOF_ARCHIVE_ENCRYPTION_KEY_BASE64;

  try {
    const blocked = preflightService('historical-state');
    assert.equal(blocked.ok, false);
    assert.ok(blocked.errors.some((e) => e.includes('PAXIOM_PROOF_ARCHIVE_MODE must be local or arweave')));
    assert.ok(blocked.errors.some((e) => e.includes('PAXIOM_PROOF_ARCHIVE_ENCRYPTION_KEY_BASE64 is required')));

    process.env.PAXIOM_PROOF_ARCHIVE_MODE = 'local';
    process.env.PAXIOM_PROOF_ARCHIVE_ENCRYPTION_KEY_BASE64 = Buffer.alloc(32, 9).toString('base64');
    const allowed = preflightService('historical-state');
    assert.equal(allowed.ok, true);
  } finally {
    restore();
  }
});
