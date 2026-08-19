// Unit tests for the live-executor /signal authentication (paxiom#104).
//
// These exercise sdk/signal-hmac.mjs directly. The logic used to be inlined in
// sdk/live-executor.js, where importing it triggered PRIVATE_KEY validation,
// viem client construction and an HTTP listen() — so it was never covered.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadSignalHmacKey,
  createSignalState,
  verifySignal,
  signSignal,
  SIGNAL_RATE_PER_MIN,
  SIGNAL_NONCE_CAP,
  SIGNAL_TS_WINDOW_MS,
} from '../signal-hmac.mjs';

const KEY = Buffer.from('ab'.repeat(32), 'hex');
const RAW = JSON.stringify({ asset: 'WETH', spreadPct: '0.5' });

function authentic({ raw = RAW, nonce = 'nonce-1', now = Date.now() } = {}) {
  return { headers: signSignal({ raw, key: KEY, nonce, now }), raw, now };
}

test('loadSignalHmacKey: accepts a >=32-byte hex key', () => {
  const key = loadSignalHmacKey({ PAXIOM_EXEC_SIGNAL_HMAC_KEY: 'cd'.repeat(32) });
  assert.equal(key.length, 32);
});

test('loadSignalHmacKey: rejects unset and too-short keys', () => {
  assert.throws(() => loadSignalHmacKey({}), /required/);
  assert.throws(() => loadSignalHmacKey({ PAXIOM_EXEC_SIGNAL_HMAC_KEY: '' }), /required/);
  assert.throws(
    () => loadSignalHmacKey({ PAXIOM_EXEC_SIGNAL_HMAC_KEY: 'ab'.repeat(16) }), // 16 bytes
    /required/
  );
});

test('happy path: an authentic request round-trips', () => {
  const state = createSignalState();
  const { headers, raw, now } = authentic();
  assert.equal(verifySignal({ headers, raw, key: KEY, now, state }), null);
});

test('missing headers are rejected', () => {
  const state = createSignalState();
  const { headers, raw, now } = authentic();
  for (const drop of ['x-paxiom-signal-ts', 'x-paxiom-signal-nonce', 'x-paxiom-signal-hmac']) {
    const partial = { ...headers };
    delete partial[drop];
    assert.equal(
      verifySignal({ headers: partial, raw, key: KEY, now, state: createSignalState() }),
      'missing-headers',
      `dropping ${drop} should be rejected`
    );
  }
  assert.equal(verifySignal({ headers: {}, raw, key: KEY, now, state }), 'missing-headers');
});

test('stale timestamps are rejected on both sides of the window', () => {
  const now = Date.now();
  const past = authentic({ now: now - SIGNAL_TS_WINDOW_MS - 1000 });
  assert.equal(
    verifySignal({ headers: past.headers, raw: RAW, key: KEY, now, state: createSignalState() }),
    'stale-timestamp'
  );
  const future = authentic({ now: now + SIGNAL_TS_WINDOW_MS + 1000 });
  assert.equal(
    verifySignal({ headers: future.headers, raw: RAW, key: KEY, now, state: createSignalState() }),
    'stale-timestamp'
  );
});

test('a replayed nonce is rejected the second time', () => {
  const state = createSignalState();
  const { headers, raw, now } = authentic({ nonce: 'replay-me' });
  assert.equal(verifySignal({ headers, raw, key: KEY, now, state }), null);
  assert.equal(verifySignal({ headers, raw, key: KEY, now, state }), 'replay');
});

test('a bad HMAC is rejected, and a tampered body invalidates a good one', () => {
  const state = createSignalState();
  const { headers, raw, now } = authentic();
  assert.equal(
    verifySignal({
      headers: { ...headers, 'x-paxiom-signal-hmac': 'ff'.repeat(32) },
      raw, key: KEY, now, state,
    }),
    'bad-sig'
  );
  // Same signature, mutated payload — the HMAC covers the body.
  assert.equal(
    verifySignal({ headers, raw: raw.replace('0.5', '99'), key: KEY, now, state }),
    'bad-sig'
  );
  // Right shape, wrong key.
  assert.equal(
    verifySignal({ headers, raw, key: Buffer.from('99'.repeat(32), 'hex'), now, state }),
    'bad-sig'
  );
});

test('rate limiting trips after SIGNAL_RATE_PER_MIN requests in a window', () => {
  const state = createSignalState();
  const now = Date.now();
  for (let i = 0; i < SIGNAL_RATE_PER_MIN; i++) {
    const { headers, raw } = authentic({ nonce: `n${i}`, now });
    assert.equal(verifySignal({ headers, raw, key: KEY, now, state }), null, `request ${i}`);
  }
  const over = authentic({ nonce: 'one-too-many', now });
  assert.equal(verifySignal({ headers: over.headers, raw: RAW, key: KEY, now, state }), 'rate-limited');

  // The bucket resets once the 60s window rolls over.
  const later = now + 61_000;
  const fresh = authentic({ nonce: 'after-window', now: later });
  assert.equal(verifySignal({ headers: fresh.headers, raw: RAW, key: KEY, now: later, state }), null);
});

test('nonce set prunes expired entries rather than wedging at the cap', () => {
  const state = createSignalState();
  const now = Date.now();
  // Fill past the cap with entries that have already expired.
  for (let i = 0; i < SIGNAL_NONCE_CAP + 10; i++) {
    state.seenNonces.set(`old-${i}`, now - 1);
  }
  assert.ok(state.seenNonces.size > SIGNAL_NONCE_CAP);
  const { headers, raw } = authentic({ nonce: 'fresh-after-prune', now });
  assert.equal(verifySignal({ headers, raw, key: KEY, now, state }), null);
  assert.equal(state.seenNonces.size, 1, 'expired nonces are pruned, only the new one remains');
});

test('nonce cap still rejects when the set is full of live entries', () => {
  const state = createSignalState();
  const now = Date.now();
  for (let i = 0; i < SIGNAL_NONCE_CAP; i++) {
    state.seenNonces.set(`live-${i}`, now + SIGNAL_TS_WINDOW_MS);
  }
  const { headers, raw } = authentic({ nonce: 'no-room', now });
  assert.equal(verifySignal({ headers, raw, key: KEY, now, state }), 'nonce-cap');
});

test('regression: verification computes an HMAC without a ReferenceError', () => {
  // sdk/live-executor.js used createHmac/timingSafeEqual without importing
  // them, so every request that reached the signature comparison threw
  // ReferenceError and was surfaced as a 400 — no authentic signal could
  // ever be executed. Reaching a 'bad-sig' verdict proves the compare ran.
  const state = createSignalState();
  const { headers, raw, now } = authentic();
  assert.equal(
    verifySignal({
      headers: { ...headers, 'x-paxiom-signal-hmac': '00'.repeat(32) },
      raw, key: KEY, now, state,
    }),
    'bad-sig'
  );
});
