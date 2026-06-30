import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  createPaymentRequired,
  decodeHeader,
  encodeHeader,
  requirePayment,
  paymentResponseHeaders,
} from '../x402.mjs';

// Spin up a mock x402 facilitator. `routes` maps '/verify' and '/settle' to
// the JSON body each should return (or a status number to fail with).
async function withMockFacilitator(routes, run) {
  const calls = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const path = req.url;
      calls.push({ path, body: JSON.parse(raw || '{}') });
      const r = routes[path];
      if (typeof r === 'number') { res.writeHead(r); res.end('{}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r ?? {}));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const prev = { ...process.env };
  process.env.REQUIRE_X402 = '1';
  process.env.X402_FACILITATOR_URL = `http://127.0.0.1:${port}`;
  delete process.env.X402_SETTLE;
  try {
    return await run({ calls });
  } finally {
    process.env = prev;
    await new Promise((resolve) => server.close(resolve));
  }
}

function fakeReq(paymentObj) {
  return { headers: { 'x-payment': encodeHeader(paymentObj) } };
}

function fakeRes() {
  return {
    statusCode: null,
    headers: null,
    body: null,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    end(body) { this.body = body; },
  };
}

const CFG = { service: 'A-202', resource: '/v1/sync-committee/verify' };

test('payment requirements round-trip as base64 JSON', () => {
  const required = createPaymentRequired({
    service: 'ARB-001',
    resource: '/v1/arb/evaluate',
  });
  const encoded = encodeHeader(required);
  const decoded = decodeHeader(encoded);
  assert.equal(decoded.x402Version, 2);
  assert.equal(decoded.resource, '/v1/arb/evaluate');
  assert.equal(decoded.asset, 'USDC');
});

test('public Phase 1 services use published draft prices', () => {
  assert.equal(createPaymentRequired({ service: 'A-201' }).maxAmountRequired, '1.00');
  assert.equal(createPaymentRequired({ service: 'A-202' }).maxAmountRequired, '0.50');
  assert.equal(createPaymentRequired({ service: 'A-203' }).maxAmountRequired, '3.00');
  assert.equal(createPaymentRequired({ service: 'A-204' }).maxAmountRequired, '0.05');
  assert.equal(createPaymentRequired({ service: 'A-205' }).maxAmountRequired, '2.00');
});

test('paid request verifies AND settles on-chain before serving', async () => {
  await withMockFacilitator(
    {
      '/verify': { isValid: true, payer: '0xpayer' },
      '/settle': { success: true, transaction: '0xdeadbeef', network: 'base-sepolia', payer: '0xpayer' },
    },
    async ({ calls }) => {
      const res = fakeRes();
      const out = await requirePayment(fakeReq({ scheme: 'exact' }), res, CFG);
      assert.equal(out.ok, true, 'should be served');
      assert.equal(out.payment.verified, true);
      assert.equal(out.payment.settled, true, 'funds must be captured');
      assert.equal(out.payment.transaction, '0xdeadbeef');
      // Both facilitator steps were invoked, in order.
      assert.deepEqual(calls.map((c) => c.path), ['/verify', '/settle']);
      // The receipt the caller receives carries the on-chain tx hash.
      const headers = paymentResponseHeaders(out.payment);
      assert.equal(decodeHeader(headers['PAYMENT-RESPONSE']).transaction, '0xdeadbeef');
      assert.equal(decodeHeader(headers['PAYMENT-RESPONSE']).settled, true);
    },
  );
});

test('valid authorization but failed settlement is NOT served (no free work)', async () => {
  await withMockFacilitator(
    {
      '/verify': { isValid: true, payer: '0xpayer' },
      '/settle': { success: false, errorReason: 'insufficient_funds' },
    },
    async () => {
      const res = fakeRes();
      const out = await requirePayment(fakeReq({ scheme: 'exact' }), res, CFG);
      assert.equal(out.ok, false);
      assert.equal(res.statusCode, 402);
      assert.match(res.body, /settlement failed/);
    },
  );
});

test('invalid authorization is rejected before any settlement attempt', async () => {
  await withMockFacilitator(
    {
      '/verify': { isValid: false, invalidReason: 'expired' },
      '/settle': { success: true, transaction: '0xshouldnothappen' },
    },
    async ({ calls }) => {
      const res = fakeRes();
      const out = await requirePayment(fakeReq({ scheme: 'exact' }), res, CFG);
      assert.equal(out.ok, false);
      assert.equal(res.statusCode, 402);
      assert.deepEqual(calls.map((c) => c.path), ['/verify'], 'must not call /settle');
    },
  );
});

test('X402_SETTLE=0 verify-only path serves without capturing funds', async () => {
  await withMockFacilitator(
    {
      '/verify': { isValid: true, payer: '0xpayer' },
      '/settle': { success: true, transaction: '0xnope' },
    },
    async ({ calls }) => {
      process.env.X402_SETTLE = '0';
      const res = fakeRes();
      const out = await requirePayment(fakeReq({ scheme: 'exact' }), res, CFG);
      assert.equal(out.ok, true);
      assert.equal(out.payment.settled, false);
      assert.deepEqual(calls.map((c) => c.path), ['/verify'], 'settlement skipped');
    },
  );
});

test('missing payment returns 402 with x402 requirements', async () => {
  await withMockFacilitator({}, async () => {
    const res = fakeRes();
    const out = await requirePayment({ headers: {} }, res, CFG);
    assert.equal(out.ok, false);
    assert.equal(res.statusCode, 402);
    const required = decodeHeader(res.headers['PAYMENT-REQUIRED']);
    assert.equal(required.maxAmountRequired, '0.50');
    assert.equal(required.resource, '/v1/sync-committee/verify');
  });
});
