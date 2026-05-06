import { createHmac, timingSafeEqual } from 'crypto';

export const SIGNAL_TS_WINDOW_MS = 30_000;
export const SIGNAL_RATE_PER_MIN = 30;
export const NONCE_CAP = 10_000;

// Audit follow-up #104: extracted from sdk/live-executor.js so verifySignal
// can be unit-tested without triggering live-executor's module-load side
// effects (PRIVATE_KEY validation, viem client construction, HTTP listen()).

export function loadSignalHmacKey(env = process.env) {
  const hex = env.PAXIOM_EXEC_SIGNAL_HMAC_KEY;
  if (!hex) {
    throw new Error('PAXIOM_EXEC_SIGNAL_HMAC_KEY required (>=32 bytes hex)');
  }
  const buf = Buffer.from(hex, 'hex');
  if (buf.length < 32) {
    throw new Error('PAXIOM_EXEC_SIGNAL_HMAC_KEY required (>=32 bytes hex)');
  }
  return buf;
}

export function createSignalState() {
  return {
    seenNonces: new Map(),
    bucket: { count: 0, windowStart: Date.now() },
  };
}

// Returns null on success, or a stable string reason on rejection.
// Reason vocabulary is part of the contract -- callers/log scrapers depend
// on these exact tokens.
export function verifySignal({ headers, raw, key, now = Date.now(), state }) {
  if (now - state.bucket.windowStart > 60_000) {
    state.bucket = { count: 0, windowStart: now };
  }
  if (++state.bucket.count > SIGNAL_RATE_PER_MIN) return 'rate-limited';

  const ts = headers['x-paxiom-signal-ts'];
  const nonce = headers['x-paxiom-signal-nonce'];
  const sig = headers['x-paxiom-signal-hmac'];
  if (!ts || !nonce || !sig) return 'missing-headers';
  if (Math.abs(now - Number(ts)) > SIGNAL_TS_WINDOW_MS) return 'stale-timestamp';

  for (const [n, exp] of state.seenNonces) if (exp < now) state.seenNonces.delete(n);
  if (state.seenNonces.has(nonce)) return 'replay';
  if (state.seenNonces.size >= NONCE_CAP) return 'nonce-cap';

  let given;
  try { given = Buffer.from(sig, 'hex'); } catch { return 'bad-sig-hex'; }
  const expected = createHmac('sha256', key).update(`${ts}.${nonce}.${raw}`).digest();
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return 'bad-sig';

  state.seenNonces.set(nonce, now + SIGNAL_TS_WINDOW_MS);
  return null;
}
