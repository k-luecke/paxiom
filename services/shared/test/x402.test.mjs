import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPaymentRequired, decodeHeader, encodeHeader } from '../x402.mjs';

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
