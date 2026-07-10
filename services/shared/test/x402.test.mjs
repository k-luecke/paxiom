import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPaymentRequired, decodeHeader, encodeHeader, toAtomic, resolveAsset } from '../x402.mjs';

test('payment requirements round-trip as base64 JSON', () => {
  const required = createPaymentRequired({
    service: 'ARB-001',
    resource: '/v1/arb/evaluate',
  });
  const encoded = encodeHeader(required);
  const decoded = decodeHeader(encoded);
  assert.equal(decoded.x402Version, 1);
  assert.equal(decoded.resource, '/v1/arb/evaluate');
  // Human annotation stays as the symbol...
  assert.equal(decoded.assetSymbol, 'USDC');
  // ...but the wire `asset` is the token contract address.
  assert.match(decoded.asset, /^0x[0-9a-fA-F]{40}$/);
  // exact scheme requires the EIP-712 domain in `extra`.
  assert.equal(decoded.extra.name, 'USDC');
  assert.equal(decoded.extra.version, '2');
});

test('public Phase 1 services expose USD prices and atomic maxAmountRequired', () => {
  const cases = {
    'A-201': { usd: '1.00', atomic: '1000000' },
    'A-202': { usd: '0.50', atomic: '500000' },
    'A-203': { usd: '3.00', atomic: '3000000' },
    'A-204': { usd: '0.05', atomic: '50000' },
    'A-205': { usd: '2.00', atomic: '2000000' },
  };
  for (const [service, expected] of Object.entries(cases)) {
    const req = createPaymentRequired({ service });
    assert.equal(req.priceUSD, expected.usd, `${service} priceUSD`);
    assert.equal(req.maxAmountRequired, expected.atomic, `${service} atomic`);
  }
});

test('toAtomic converts decimal USD to 6-decimal atomic units', () => {
  assert.equal(toAtomic('0.05', 6), '50000');
  assert.equal(toAtomic('1', 6), '1000000');
  assert.equal(toAtomic('1.234567', 6), '1234567');
  assert.equal(toAtomic('0.000001', 6), '1');
});

test('resolveAsset returns the Base Sepolia USDC contract', () => {
  const token = resolveAsset('base-sepolia', 'USDC');
  assert.equal(token.address, '0x036CbD53842c5426634e7929541eC2318f3dCF7e');
  assert.equal(token.decimals, 6);
  assert.equal(token.eip712.name, 'USDC');
});
