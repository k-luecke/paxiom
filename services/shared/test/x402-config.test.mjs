// x402 runtime configuration (#96): env floor, operator store above it,
// per-request opts that may only restrict.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeConfig } from '../config-store.mjs';
import {
  CONFIG_NAME, DEFAULT_PRICES, DEFAULT_ACCEPTED_VERIFY_KEYS,
  approvedFacilitatorUrls, facilitatorUrl, priceFor, acceptedVerifyKeys,
  isFacilitatorVerified, toAtomicAmount, clearX402ConfigCache,
} from '../x402-config.mjs';

const FAC = 'https://facilitator.example';
const ALT = 'https://alt-facilitator.example';

function sandbox(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'paxiom-x402-'));
  clearX402ConfigCache();
  return {
    PAXIOM_CONFIG_DIR: join(root, 'config'),
    PAXIOM_AUDIT_LOG_DIR: join(root, 'log'),
    X402_FACILITATOR_URL: FAC,
    ...extra,
  };
}

function store(env, value) {
  writeConfig(CONFIG_NAME, value, { actor: '0xadmin', action: 'x402.update', env });
  clearX402ConfigCache();
}

// ── prices ────────────────────────────────────────────────────────────────

test('prices default to the published catalog values', () => {
  const env = sandbox();
  assert.equal(priceFor('A-201', { env }), '1.00');
  assert.equal(priceFor('A-202', { env }), '0.50');
  assert.equal(priceFor('A-204', { env }), '0.05');
  assert.equal(priceFor('unknown-service', { env }), '0.01', 'fallback for an unlisted service');
});

test('an operator override in the store replaces the default', () => {
  const env = sandbox();
  store(env, { prices: { 'A-202': '0.75' } });
  assert.equal(priceFor('A-202', { env }), '0.75');
  assert.equal(priceFor('A-201', { env }), '1.00', 'unrelated services are untouched');
});

test('a per-request override may RAISE the price', () => {
  const env = sandbox();
  assert.equal(priceFor('A-202', { env, opts: { amount: '5.00' } }), '5.00');
});

test('a per-request override may NOT undercut the configured price', () => {
  const env = sandbox();
  assert.equal(priceFor('A-202', { env, opts: { amount: '0.01' } }), '0.50',
    'a caller must not be able to talk the service into charging less');
  assert.equal(priceFor('A-202', { env, opts: { amount: '0' } }), '0.50');
  assert.equal(priceFor('A-202', { env, opts: { amount: '0.50' } }), '0.50', 'equal is not a raise');
});

test('a per-request override is compared against the STORE price, not the default', () => {
  const env = sandbox();
  store(env, { prices: { 'A-204': '2.00' } });   // operator raised it well above the 0.05 default
  assert.equal(priceFor('A-204', { env, opts: { amount: '0.10' } }), '2.00',
    '0.10 beats the default but undercuts the operator price, so it is ignored');
});

test('price comparison is exact, not floating point', () => {
  const env = sandbox();
  store(env, { prices: { 'A-201': '0.1' } });
  // 0.1 + 0.2 !== 0.3 in binary floating point; the comparison must not care.
  assert.equal(priceFor('A-201', { env, opts: { amount: '0.10' } }), '0.1', 'equal values, no raise');
  assert.equal(priceFor('A-201', { env, opts: { amount: '0.1000001' } }), '0.1000001');
});

test('toAtomicAmount keeps decimal precision', () => {
  assert.equal(toAtomicAmount('0.50', 6), '500000');
  assert.equal(toAtomicAmount('1.00', 6), '1000000');
  assert.equal(toAtomicAmount('0.05', 6), '50000');
  assert.equal(toAtomicAmount('3', 6), '3000000');
});

// ── facilitator selection ─────────────────────────────────────────────────

test('with no stored selection the env URL is used', () => {
  const env = sandbox();
  assert.deepEqual(facilitatorUrl(env), { url: FAC, source: 'env', rejected: null });
});

test('the approved set always contains the env URL', () => {
  assert.deepEqual(approvedFacilitatorUrls(sandbox()), [FAC]);
  assert.deepEqual(
    approvedFacilitatorUrls(sandbox({ X402_FACILITATOR_URL_ALLOWED: `${ALT},${FAC}` })),
    [FAC, ALT],
    'de-duplicated, env URL first'
  );
});

test('an operator may rotate to a URL the env approved', () => {
  const env = sandbox({ X402_FACILITATOR_URL_ALLOWED: ALT });
  store(env, { facilitatorUrl: ALT });
  assert.deepEqual(facilitatorUrl(env), { url: ALT, source: 'store', rejected: null });
});

test('a URL outside the approved set is refused, falling back to env', () => {
  const env = sandbox();
  store(env, { facilitatorUrl: 'https://attacker.example' });
  const got = facilitatorUrl(env);
  assert.equal(got.url, FAC, 'the env floor holds');
  assert.equal(got.source, 'env');
  assert.equal(got.rejected, 'not-in-approved-set',
    'the refusal is reported so an ignored rotation is not silent');
});

test('the store cannot introduce a facilitator when the env floor is unset', () => {
  const env = sandbox({ X402_FACILITATOR_URL: '' });
  store(env, { facilitatorUrl: ALT });
  const got = facilitatorUrl(env);
  assert.equal(got.url, '', 'no floor means no facilitator, whatever the store says');
  assert.equal(got.rejected, 'no-env-floor');
});

test('trailing slashes do not defeat the approved-set check', () => {
  const env = sandbox({ X402_FACILITATOR_URL_ALLOWED: `${ALT}/` });
  store(env, { facilitatorUrl: `${ALT}///` });
  assert.equal(facilitatorUrl(env).url, ALT);
});

// ── accepted response shapes ──────────────────────────────────────────────

test('both legacy and spec success keys are accepted by default', () => {
  const env = sandbox();
  assert.deepEqual(acceptedVerifyKeys(env), [...DEFAULT_ACCEPTED_VERIFY_KEYS]);
  assert.equal(isFacilitatorVerified({ isValid: true }, env), true);
  assert.equal(isFacilitatorVerified({ verified: true }, env), true);
  assert.equal(isFacilitatorVerified({ isValid: false }, env), false);
  assert.equal(isFacilitatorVerified({}, env), false);
  assert.equal(isFacilitatorVerified(null, env), false);
});

test('config may NARROW the accepted shapes', () => {
  const env = sandbox();
  store(env, { acceptedVerifyKeys: ['isValid'] });
  assert.deepEqual(acceptedVerifyKeys(env), ['isValid']);
  assert.equal(isFacilitatorVerified({ isValid: true }, env), true);
  assert.equal(isFacilitatorVerified({ verified: true }, env), false,
    'a narrowed verifier rejects the legacy shape');
});

test('config may NOT teach the verifier a new success shape', () => {
  const env = sandbox();
  store(env, { acceptedVerifyKeys: ['isValid', 'ok', 'success', 'paid'] });
  assert.deepEqual(acceptedVerifyKeys(env), ['isValid'], 'unknown keys are dropped, not honoured');
  assert.equal(isFacilitatorVerified({ ok: true }, env), false);
  assert.equal(isFacilitatorVerified({ success: true }, env), false);
});

test('narrowing to nothing is ignored rather than rejecting every payment', () => {
  const env = sandbox();
  store(env, { acceptedVerifyKeys: [] });
  assert.deepEqual(acceptedVerifyKeys(env), [...DEFAULT_ACCEPTED_VERIFY_KEYS]);
  store(env, { acceptedVerifyKeys: ['nonsense'] });
  assert.deepEqual(acceptedVerifyKeys(env), [...DEFAULT_ACCEPTED_VERIFY_KEYS]);
  store(env, { acceptedVerifyKeys: 'isValid' });   // not an array
  assert.deepEqual(acceptedVerifyKeys(env), [...DEFAULT_ACCEPTED_VERIFY_KEYS]);
});

// ── cache ─────────────────────────────────────────────────────────────────

test('a store change is picked up without a restart', () => {
  const env = sandbox();
  assert.equal(priceFor('A-202', { env }), '0.50');
  writeConfig(CONFIG_NAME, { prices: { 'A-202': '9.99' } },
    { actor: '0xadmin', action: 'x402.update', env });
  clearX402ConfigCache();
  assert.equal(priceFor('A-202', { env }), '9.99');
});

test('every price in the catalog has a default', () => {
  for (const svc of ['A-201', 'A-202', 'A-203', 'A-204', 'A-205']) {
    assert.ok(DEFAULT_PRICES[svc], `${svc} must have a published price`);
  }
});
