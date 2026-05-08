// demo-verifier-v0
//
// One deterministic check: the caller submits a UTF-8 message and a claimed
// SHA-256 digest. The verifier recomputes SHA-256(message) and compares.
//
// This is intentionally trivial. It is the smallest verification that produces
// a real, reproducible result. The receipt machinery around it (canonical
// hashing, signing, replay) is the actual product surface and stays the same
// when this verifier is later replaced with a signature, fixture-proof, or
// Ethereum verifier.

import { createHash } from 'node:crypto';

export const VERIFIER_NAME = 'demo-verifier-v0';
export const VERIFIER_VERSION = '0.1.0';

export function sha256Hex(input) {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return createHash('sha256').update(buf).digest('hex');
}

function normalizeHex(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]+$/.test(trimmed)) return null;
  return trimmed;
}

export function verify(input) {
  if (!input || typeof input !== 'object') {
    return invalid('input must be a JSON object');
  }
  if (typeof input.message !== 'string') {
    return invalid('field "message" must be a string');
  }
  const claimed = normalizeHex(input.claimed_sha256);
  if (!claimed) {
    return invalid('field "claimed_sha256" must be a hex string');
  }
  if (claimed.length !== 64) {
    return invalid('field "claimed_sha256" must be 32 bytes (64 hex chars)');
  }

  const computed = sha256Hex(input.message);
  const inputHash = sha256Hex(canonicalInput(input));
  const outputHash = sha256Hex(`${computed}:${claimed}`);

  if (computed === claimed) {
    return {
      decision: 'pass',
      reason: 'computed sha256 of message matches claimed_sha256',
      input_hash: inputHash,
      output_hash: outputHash,
      details: { computed_sha256: computed, claimed_sha256: claimed },
    };
  }
  return {
    decision: 'fail',
    reason: 'computed sha256 of message does not match claimed_sha256',
    input_hash: inputHash,
    output_hash: outputHash,
    details: { computed_sha256: computed, claimed_sha256: claimed },
  };
}

function invalid(reason) {
  return {
    decision: 'fail',
    reason,
    input_hash: null,
    output_hash: null,
    details: null,
    invalid: true,
  };
}

function canonicalInput(input) {
  return JSON.stringify({
    message: input.message,
    claimed_sha256: normalizeHex(input.claimed_sha256),
  });
}
