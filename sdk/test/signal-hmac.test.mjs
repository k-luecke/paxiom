import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'crypto';
import {
  verifySignal,
  loadSignalHmacKey,
  createSignalState,
  SIGNAL_TS_WINDOW_MS,
  SIGNAL_RATE_PER_MIN,
  NONCE_CAP,
} from '../signal-hmac.mjs';

const KEY = randomBytes(32);

function sign({
  body = '{}',
  ts = String(Date.now()),
  nonce = randomBytes(16).toString('hex'),
  key = KEY,
} = {}) {
  const hmac = createHmac('sha256', key).update(`${ts}.${nonce}.${body}`).digest('hex');
  return {
    headers: {
      'x-paxiom-signal-ts': ts,
      'x-paxiom-signal-nonce': nonce,
      'x-paxiom-signal-hmac': hmac,
    },
    raw: body,
  };
}

test('happy path round-trip returns null', () => {
  const state = createSignalState();
  const { headers, raw } = sign();
  assert.equal(verifySignal({ headers, raw, key: KEY, state }), null);
});

test('missing headers returns missing-headers', () => {
  const state = createSignalState();
  assert.equal(
    verifySignal({ headers: {}, raw: '{}', key: KEY, state }),
    'missing-headers'
  );
});

test('stale timestamp returns stale-timestamp', () => {
  const state = createSignalState();
  const stale = String(Date.now() - SIGNAL_TS_WINDOW_MS - 1000);
  const { headers, raw } = sign({ ts: stale });
  assert.equal(verifySignal({ headers, raw, key: KEY, state }), 'stale-timestamp');
});

test('replayed nonce returns replay on second use', () => {
  const state = createSignalState();
  const { headers, raw } = sign();
  assert.equal(verifySignal({ headers, raw, key: KEY, state }), null);
  assert.equal(verifySignal({ headers, raw, key: KEY, state }), 'replay');
});

test('wrong key returns bad-sig', () => {
  const state = createSignalState();
  const wrongKey = randomBytes(32);
  const { headers, raw } = sign({ key: wrongKey });
  assert.equal(verifySignal({ headers, raw, key: KEY, state }), 'bad-sig');
});

test('rate limit returns rate-limited after SIGNAL_RATE_PER_MIN successes', () => {
  const state = createSignalState();
  for (let i = 0; i < SIGNAL_RATE_PER_MIN; i++) {
    const r = sign();
    const reason = verifySignal({ headers: r.headers, raw: r.raw, key: KEY, state });
    assert.equal(reason, null, `iteration ${i} unexpectedly rejected: ${reason}`);
  }
  const r = sign();
  assert.equal(
    verifySignal({ headers: r.headers, raw: r.raw, key: KEY, state }),
    'rate-limited'
  );
});

test('nonce LRU prunes expired entries on next verify', () => {
  const state = createSignalState();
  state.seenNonces.set('expired-nonce', Date.now() - 1000);
  const { headers, raw } = sign();
  verifySignal({ headers, raw, key: KEY, state });
  assert.equal(state.seenNonces.has('expired-nonce'), false);
});

test('nonce cap returns nonce-cap when seenNonces is full', () => {
  const state = createSignalState();
  const future = Date.now() + 60_000;
  for (let i = 0; i < NONCE_CAP; i++) {
    state.seenNonces.set(`nonce-${i}`, future);
  }
  const { headers, raw } = sign();
  assert.equal(verifySignal({ headers, raw, key: KEY, state }), 'nonce-cap');
});

test('loadSignalHmacKey throws when env missing', () => {
  assert.throws(() => loadSignalHmacKey({}), /required/);
});

test('loadSignalHmacKey throws when key shorter than 32 bytes', () => {
  assert.throws(
    () => loadSignalHmacKey({ PAXIOM_EXEC_SIGNAL_HMAC_KEY: 'aa'.repeat(16) }),
    /required/
  );
});

test('loadSignalHmacKey returns 32-byte Buffer for valid hex', () => {
  const key = loadSignalHmacKey({ PAXIOM_EXEC_SIGNAL_HMAC_KEY: 'aa'.repeat(32) });
  assert.equal(key.length, 32);
  assert.ok(Buffer.isBuffer(key));
});
