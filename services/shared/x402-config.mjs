// Runtime x402 configuration: the env floor, plus the operator-mutable layer
// stored in the shared ConfigStore (#96).
//
// The shape of the contract, which the sibling issues (#90, #92, #98, #106)
// follow:
//
//   env is the floor.        Deploy-time, root-owned, requires a restart.
//   the store sits above it. Authenticated, audited, changeable at runtime.
//   per-request opts may only RESTRICT. Never expand access.
//
// Concretely, none of these can be relaxed at runtime:
//   - the facilitator URL can never become empty, and can only be switched to
//     a URL the env already approved;
//   - the accepted facilitator response shapes can only be NARROWED from the
//     built-in set — config cannot teach the verifier a new success shape;
//   - a per-request price override can only raise the price, never undercut
//     the configured one.
//
// This module has no imports from x402.mjs, so x402.mjs can depend on it
// without a cycle. The decimal->atomic conversion lives here for the same
// reason: one definition, used by both.

import { existsSync, statSync } from 'node:fs';
import { configPath, readConfig } from './config-store.mjs';

export const CONFIG_NAME = 'x402-config';

// Prices are published in whole USDC; x402 carries the ATOMIC amount.
export const DEFAULT_PRICES = Object.freeze({
  'A-201': '1.00',
  'A-202': '0.50',
  'A-203': '3.00',
  'A-204': '0.05',
  'A-205': '2.00',
  'R-200': '0.02',
  'ARB-001': '0.01',
  'COMPLIANCE-001': '0.01',
});
export const FALLBACK_PRICE = '0.01';

// The facilitator response keys that may signal success. Config may narrow
// this list; it may never extend it. Accepting `verified` as well as the
// spec's `isValid` is legacy tolerance — an operator running a spec-compliant
// facilitator should narrow to ['isValid'].
export const DEFAULT_ACCEPTED_VERIFY_KEYS = Object.freeze(['isValid', 'verified']);

// "0.50" -> "500000" (6dp). String math so we never touch float precision.
export function toAtomicAmount(amount, decimals) {
  const [whole, frac = ''] = String(amount).split('.');
  const fracPadded = `${frac}${'0'.repeat(decimals)}`.slice(0, decimals);
  return (BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(fracPadded || '0')).toString();
}

// Compare two decimal price strings exactly. Float comparison would be wrong
// for the same reason float arithmetic is wrong for money.
function comparePrices(a, b) {
  const av = BigInt(toAtomicAmount(a, 8));
  const bv = BigInt(toAtomicAmount(b, 8));
  return av === bv ? 0 : (av > bv ? 1 : -1);
}

function normalizeUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

// mtime-keyed cache: the store is read on nearly every paid request, and
// re-parsing the file each time is waste. Keyed on mtime+size so an external
// edit is picked up without a restart.
let cache = { key: null, value: null };

export function loadX402Config(env = process.env) {
  const path = configPath(CONFIG_NAME, env);
  if (!existsSync(path)) {
    cache = { key: null, value: null };
    return {};
  }
  const st = statSync(path);
  const key = `${path}:${st.mtimeMs}:${st.size}`;
  if (cache.key === key) return cache.value;
  const value = readConfig(CONFIG_NAME, { fallback: {}, env }) ?? {};
  cache = { key, value };
  return value;
}

/** Test seam — drop the mtime cache. */
export function clearX402ConfigCache() {
  cache = { key: null, value: null };
}

/**
 * URLs the operator is permitted to select between: the env URL, plus any
 * listed in X402_FACILITATOR_URL_ALLOWED. The env URL is always a member, so
 * the approved set can never be empty while the floor is set.
 */
export function approvedFacilitatorUrls(env = process.env) {
  const envUrl = normalizeUrl(env.X402_FACILITATOR_URL);
  const extra = String(env.X402_FACILITATOR_URL_ALLOWED || '')
    .split(',').map(normalizeUrl).filter(Boolean);
  return [...new Set([envUrl, ...extra].filter(Boolean))];
}

/**
 * The facilitator URL in effect.
 *
 * Returns `{ url, source, rejected }`. `source` is 'store' when the operator's
 * selection is honoured and 'env' when it is not; `rejected` explains why so
 * the caller can log a selection that was silently ignored rather than leave
 * an operator believing a rotation took effect.
 */
export function facilitatorUrl(env = process.env) {
  const envUrl = normalizeUrl(env.X402_FACILITATOR_URL);
  const selected = normalizeUrl(loadX402Config(env).facilitatorUrl);
  if (!selected) return { url: envUrl, source: 'env', rejected: null };
  if (!envUrl) {
    // No floor: the store must not be able to introduce a facilitator on its
    // own. Without an env URL the caller has no business making paid calls,
    // and x402.mjs fails closed before reaching here.
    return { url: '', source: 'env', rejected: 'no-env-floor' };
  }
  if (!approvedFacilitatorUrls(env).includes(selected)) {
    return { url: envUrl, source: 'env', rejected: 'not-in-approved-set' };
  }
  return { url: selected, source: 'store', rejected: null };
}

/**
 * Price for a service, in whole USDC.
 *
 * env/built-in default -> operator override from the store -> per-request
 * override, which may only raise. A per-request value below the configured
 * price is ignored, so a caller cannot talk the service into charging less.
 */
export function priceFor(service, { env = process.env, opts = {} } = {}) {
  const base = DEFAULT_PRICES[service] || FALLBACK_PRICE;
  const stored = loadX402Config(env).prices?.[service];
  const configured = stored != null ? String(stored) : base;
  const requested = opts.amount != null ? String(opts.amount) : null;
  if (requested != null && comparePrices(requested, configured) > 0) return requested;
  return configured;
}

/**
 * The facilitator response keys accepted as success, narrowed by config.
 *
 * An unknown key in the config list is dropped rather than honoured — this is
 * the "never expand" rule. A config that narrows to nothing is ignored too:
 * an empty list would reject every response, which is a denial of service
 * dressed up as a tightening, and almost certainly a config mistake.
 */
export function acceptedVerifyKeys(env = process.env) {
  const configured = loadX402Config(env).acceptedVerifyKeys;
  if (!Array.isArray(configured)) return [...DEFAULT_ACCEPTED_VERIFY_KEYS];
  const narrowed = configured.filter((k) => DEFAULT_ACCEPTED_VERIFY_KEYS.includes(k));
  return narrowed.length > 0 ? narrowed : [...DEFAULT_ACCEPTED_VERIFY_KEYS];
}

/** True when the facilitator's /verify body signals success under the accepted shapes. */
export function isFacilitatorVerified(body, env = process.env) {
  if (!body || typeof body !== 'object') return false;
  return acceptedVerifyKeys(env).some((k) => body[k] === true);
}
