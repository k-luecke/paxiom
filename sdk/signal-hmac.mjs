// Shared-secret authentication for the live-executor `/signal` endpoint.
//
// Extracted from sdk/live-executor.js so the verification logic can be unit
// tested: importing live-executor.js triggers PRIVATE_KEY validation, viem
// client construction and an HTTP listen(), which makes testing the check
// impractical. Nothing in this module touches the environment or the network
// at import time.
//
// Wire format — the caller sends three headers alongside the raw request body:
//   X-Paxiom-Signal-Ts     ms-epoch timestamp
//   X-Paxiom-Signal-Nonce  unique per request within the timestamp window
//   X-Paxiom-Signal-Hmac   hex HMAC-SHA256 over `${ts}.${nonce}.${raw}`

import { createHmac, timingSafeEqual } from 'crypto';

export const SIGNAL_TS_WINDOW_MS = 30_000;
export const SIGNAL_RATE_PER_MIN = 30;
export const SIGNAL_NONCE_CAP = 10_000;

/**
 * Read and validate the shared HMAC secret. Throws if unset or too short —
 * a short key is treated as a configuration error rather than silently
 * accepted, since it is the only thing standing between a local process and
 * a signed broadcast.
 */
export function loadSignalHmacKey(env = process.env) {
  const hex = env.PAXIOM_EXEC_SIGNAL_HMAC_KEY;
  if (!hex || Buffer.from(hex, 'hex').length < 32) {
    throw new Error(
      'PAXIOM_EXEC_SIGNAL_HMAC_KEY required (>=32 bytes hex). ' +
      'Generate: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  return Buffer.from(hex, 'hex');
}

/** Fresh mutable state for a verifier instance (nonce replay set + rate bucket). */
export function createSignalState(now = Date.now()) {
  return { seenNonces: new Map(), bucket: { count: 0, windowStart: now } };
}

/**
 * Verify one signal request.
 * Returns null when the request is authentic, or a short reason string:
 * 'rate-limited' | 'missing-headers' | 'stale-timestamp' | 'replay' |
 * 'nonce-cap' | 'bad-sig-hex' | 'bad-sig'.
 */
export function verifySignal({ headers, raw, key, now = Date.now(), state }) {
  if (state.bucket.windowStart === undefined || now - state.bucket.windowStart > 60_000) {
    state.bucket = { count: 0, windowStart: now };
  }
  if (++state.bucket.count > SIGNAL_RATE_PER_MIN) return 'rate-limited';

  const ts = headers['x-paxiom-signal-ts'];
  const nonce = headers['x-paxiom-signal-nonce'];
  const sig = headers['x-paxiom-signal-hmac'];
  if (!ts || !nonce || !sig) return 'missing-headers';
  if (!Number.isFinite(Number(ts)) || Math.abs(now - Number(ts)) > SIGNAL_TS_WINDOW_MS) {
    return 'stale-timestamp';
  }

  // Prune expired nonces before the cap check, so a steady request rate does
  // not wedge the endpoint at 'nonce-cap' forever.
  for (const [n, exp] of state.seenNonces) if (exp < now) state.seenNonces.delete(n);
  if (state.seenNonces.has(nonce)) return 'replay';
  if (state.seenNonces.size >= SIGNAL_NONCE_CAP) return 'nonce-cap';

  let given;
  try { given = Buffer.from(sig, 'hex'); } catch { return 'bad-sig-hex'; }
  const expected = createHmac('sha256', key).update(`${ts}.${nonce}.${raw}`).digest();
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return 'bad-sig';

  state.seenNonces.set(nonce, now + SIGNAL_TS_WINDOW_MS);
  return null;
}

/** Build the three headers for an authentic request. Mirrors verifySignal. */
export function signSignal({ raw, key, nonce, now = Date.now() }) {
  const ts = String(now);
  return {
    'x-paxiom-signal-ts': ts,
    'x-paxiom-signal-nonce': nonce,
    'x-paxiom-signal-hmac': createHmac('sha256', key)
      .update(`${ts}.${nonce}.${raw}`).digest('hex'),
  };
}
