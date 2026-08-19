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

test('payment requirements are x402-spec-compliant for base-sepolia USDC', () => {
  const required = createPaymentRequired({
    service: 'ARB-001',
    resource: '/v1/arb/evaluate',
  });
  const decoded = decodeHeader(encodeHeader(required));
  assert.equal(decoded.x402Version, 2);
  assert.equal(decoded.scheme, 'exact');
  assert.equal(decoded.resource, '/v1/arb/evaluate');
  // asset must be the USDC CONTRACT address, not a symbol.
  assert.equal(decoded.asset, '0x036CbD53842c5426634e7929541eC2318f3dCF7e');
  // EIP-712 domain the payer signs over.
  assert.deepEqual(decoded.extra, { name: 'USDC', version: '2' });
});

test('prices are carried as atomic USDC amounts (6dp)', () => {
  assert.equal(createPaymentRequired({ service: 'A-201' }).maxAmountRequired, '1000000');
  assert.equal(createPaymentRequired({ service: 'A-202' }).maxAmountRequired, '500000');
  assert.equal(createPaymentRequired({ service: 'A-203' }).maxAmountRequired, '3000000');
  assert.equal(createPaymentRequired({ service: 'A-204' }).maxAmountRequired, '50000');
  assert.equal(createPaymentRequired({ service: 'A-205' }).maxAmountRequired, '2000000');
});

test('mainnet network selects mainnet USDC + domain name', () => {
  const required = createPaymentRequired({ service: 'A-202', network: 'base' });
  assert.equal(required.network, 'base');
  assert.equal(required.asset, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
  assert.equal(required.extra.name, 'USD Coin');
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
    assert.equal(required.maxAmountRequired, '500000');
    assert.match(required.resource, /\/v1\/sync-committee\/verify$/);
  });
});

// ── #96 wiring: the ConfigStore layer actually reaches requirePayment ──────
//
// x402-config.test.mjs proves the config module in isolation. These prove
// x402.mjs really consults it — the join is where this would silently fail,
// leaving a store that nothing reads.

import { mkdtempSync } from 'node:fs';
import { tmpdir as osTmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { writeConfig } from '../config-store.mjs';
import { CONFIG_NAME, clearX402ConfigCache } from '../x402-config.mjs';

async function withStore(value, run) {
  const root = mkdtempSync(pathJoin(osTmpdir(), 'paxiom-x402-wire-'));
  const saved = {
    dir: process.env.PAXIOM_CONFIG_DIR,
    log: process.env.PAXIOM_AUDIT_LOG_DIR,
  };
  process.env.PAXIOM_CONFIG_DIR = pathJoin(root, 'config');
  process.env.PAXIOM_AUDIT_LOG_DIR = pathJoin(root, 'log');
  clearX402ConfigCache();
  if (value) {
    writeConfig(CONFIG_NAME, value, { actor: '0xadmin', action: 'x402.update' });
    clearX402ConfigCache();
  }
  try {
    return await run();
  } finally {
    if (saved.dir === undefined) delete process.env.PAXIOM_CONFIG_DIR;
    else process.env.PAXIOM_CONFIG_DIR = saved.dir;
    if (saved.log === undefined) delete process.env.PAXIOM_AUDIT_LOG_DIR;
    else process.env.PAXIOM_AUDIT_LOG_DIR = saved.log;
    clearX402ConfigCache();
  }
}

test('#96: a stored price override changes the 402 challenge amount', async () => {
  await withStore(null, () => {
    assert.equal(createPaymentRequired({ service: 'A-202' }).maxAmountRequired, '500000');
  });
  await withStore({ prices: { 'A-202': '2.50' } }, () => {
    assert.equal(createPaymentRequired({ service: 'A-202' }).maxAmountRequired, '2500000',
      'the operator price reaches the requirements the payer signs over');
  });
});

test('#96: a caller-supplied amount cannot undercut the stored price', async () => {
  await withStore({ prices: { 'A-202': '2.50' } }, () => {
    assert.equal(
      createPaymentRequired({ service: 'A-202', amount: '0.01' }).maxAmountRequired,
      '2500000',
    );
    assert.equal(
      createPaymentRequired({ service: 'A-202', amount: '9.00' }).maxAmountRequired,
      '9000000',
      'raising is still allowed',
    );
  });
});

test('#96: narrowing acceptedVerifyKeys rejects the legacy facilitator shape', async () => {
  // The mock answers {verified:true} — accepted by default, refused once the
  // operator narrows to the spec's isValid.
  await withMockFacilitator(
    {
      '/verify': { verified: true, payer: '0xpayer' },
      '/settle': { success: true, transaction: '0xtx', payer: '0xpayer' },
    },
    async () => {
      await withStore(null, async () => {
        const res = fakeRes();
        const out = await requirePayment(fakeReq({ scheme: 'exact' }), res, CFG);
        assert.equal(out.ok, true, 'legacy shape accepted by default');
      });
      await withStore({ acceptedVerifyKeys: ['isValid'] }, async () => {
        const res = fakeRes();
        const out = await requirePayment(fakeReq({ scheme: 'exact' }), res, CFG);
        assert.equal(out.ok, false, 'narrowed verifier refuses {verified:true}');
        assert.equal(res.statusCode, 402);
      });
    },
  );
});

test('#96: a facilitator URL outside the approved set is ignored', async () => {
  await withMockFacilitator(
    {
      '/verify': { isValid: true, payer: '0xpayer' },
      '/settle': { success: true, transaction: '0xtx', payer: '0xpayer' },
    },
    async ({ calls }) => {
      // The store names an unapproved host. The env floor must win, so the
      // request still lands on the mock rather than the attacker's URL.
      await withStore({ facilitatorUrl: 'https://attacker.example' }, async () => {
        const res = fakeRes();
        const out = await requirePayment(fakeReq({ scheme: 'exact' }), res, CFG);
        assert.equal(out.ok, true);
        assert.ok(calls.length >= 1, 'the approved facilitator was the one called');
      });
    },
  );
});
