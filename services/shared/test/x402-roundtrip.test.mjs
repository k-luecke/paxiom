// End-to-end proof of the x402 verify -> settle loop, fully in-process:
//   payer client  ->  A-204 service (REQUIRE_X402=1)  ->  mock facilitator
// The mock facilitator does REAL EIP-712 recovery; only the on-chain broadcast
// is simulated. This is the offline stand-in for the real Base Sepolia run.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createApp as createFacilitator } from '../../../scripts/mock-facilitator.mjs';
import { createApp as createSimulation } from '../../simulation/server.mjs';
import { x402Fetch } from '../x402-client.mjs';

const MERCHANT = '0x1111111111111111111111111111111111111111';
let facilitator, service, serviceUrl;

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

before(async () => {
  facilitator = createFacilitator();
  const fPort = await listen(facilitator);

  process.env.REQUIRE_X402 = '1';
  process.env.X402_FACILITATOR_URL = `http://127.0.0.1:${fPort}`;
  process.env.X402_NETWORK = 'base-sepolia';
  process.env.X402_ASSET = 'USDC';
  process.env.X402_DESTINATION = MERCHANT;

  service = createSimulation();
  const sPort = await listen(service);
  serviceUrl = `http://127.0.0.1:${sPort}/v1/simulations`;
});

after(() => {
  facilitator?.close();
  service?.close();
  delete process.env.REQUIRE_X402;
  delete process.env.X402_FACILITATOR_URL;
  delete process.env.X402_DESTINATION;
});

test('unpaid request is challenged with a wire-compatible 402', async () => {
  const resp = await fetch(serviceUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chain: 'base', to: '0x' + '22'.repeat(20) }),
  });
  assert.equal(resp.status, 402);
  const body = await resp.json();
  const challenge = body.payment_required;
  assert.equal(challenge.scheme, 'exact');
  assert.match(challenge.asset, /^0x[0-9a-fA-F]{40}$/);
  assert.equal(challenge.maxAmountRequired, '50000'); // $0.05 @ 6 decimals
  assert.equal(challenge.payTo, MERCHANT);
  assert.ok(challenge.extra?.name, 'challenge carries EIP-712 domain');
});

test('signed payment verifies, settles, and unlocks the resource', async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const { response, paid, receipt } = await x402Fetch(
    serviceUrl,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chain: 'base', to: '0x' + '33'.repeat(20) }),
    },
    account,
  );

  assert.equal(paid, true, 'client had to satisfy a 402');
  assert.equal(response.status, 200, 'paid request succeeded');

  const envelope = await response.json();
  assert.equal(envelope.service, 'A-204');
  assert.equal(envelope.payment.mode, 'facilitator');
  assert.equal(envelope.payment.verified, true);
  assert.equal(envelope.payment.settled, true);

  // The response receipt must carry a settlement tx hash.
  assert.ok(receipt, 'PAYMENT-RESPONSE receipt present');
  assert.equal(receipt.settled, true);
  assert.match(receipt.settled_tx, /^0x[0-9a-fA-F]{64}$/);
  assert.equal(receipt.network, 'base-sepolia');
});

test('a tampered payment signature is rejected at settlement', async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  // Build a valid header, then corrupt the signature so recovery fails.
  const first = await fetch(serviceUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chain: 'base', to: '0x' + '44'.repeat(20) }),
  });
  const challenge = (await first.json()).payment_required;
  const { buildPayment } = await import('../x402-client.mjs');
  const { payload } = await buildPayment(challenge, account);
  payload.payload.signature = '0x' + '00'.repeat(65);
  const header = Buffer.from(JSON.stringify(payload)).toString('base64');

  const resp = await fetch(serviceUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-PAYMENT': header },
    body: JSON.stringify({ chain: 'base', to: '0x' + '44'.repeat(20) }),
  });
  assert.equal(resp.status, 402, 'invalid signature is refused');
});
