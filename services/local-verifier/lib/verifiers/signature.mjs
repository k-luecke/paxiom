// signature-verifier-v0
//
// Verifies that `signature` is a valid `algorithm` signature over the
// canonical-JSON encoding of `payload` under `public_key_pem`.
//
// Reason codes (per chassis spec):
//   pass: signature_valid
//   fail: signature_invalid | unsupported_algorithm | malformed_input
//
// Receipts issued for every reason code (including malformed_input) so
// the audit chain stays uninterrupted. HTTP layer maps decision -> status.
//
// Algorithms today: ed25519 only. Add new ones by extending
// SUPPORTED_ALGORITHMS and the dispatch in `cryptoVerifyDispatch`.

import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { canonicalJson } from '../canonical.mjs';

export const VERIFIER_NAME = 'signature-verifier-v0';
export const VERIFIER_VERSION = '0.1.0';
export const SUPPORTED_ALGORITHMS = ['ed25519'];

export function verify(input) {
  const inputHash = safeInputHash(input);

  if (!input || typeof input !== 'object') {
    return fail('malformed_input', inputHash, { detail: 'input must be a JSON object' });
  }
  const { payload, public_key_pem, signature, algorithm } = input;
  if (typeof payload === 'undefined') {
    return fail('malformed_input', inputHash, { detail: 'field "payload" is required' });
  }
  if (typeof public_key_pem !== 'string' || public_key_pem.length === 0) {
    return fail('malformed_input', inputHash, { detail: 'field "public_key_pem" must be a non-empty string' });
  }
  if (typeof signature !== 'string' || signature.length === 0) {
    return fail('malformed_input', inputHash, { detail: 'field "signature" must be a non-empty base64 string' });
  }
  if (typeof algorithm !== 'string' || algorithm.length === 0) {
    return fail('malformed_input', inputHash, { detail: 'field "algorithm" must be a non-empty string' });
  }

  if (!SUPPORTED_ALGORITHMS.includes(algorithm)) {
    return fail('unsupported_algorithm', inputHash, {
      algorithm,
      supported: SUPPORTED_ALGORITHMS,
    });
  }

  let publicKey;
  try {
    publicKey = createPublicKey(public_key_pem);
  } catch (e) {
    return fail('malformed_input', inputHash, { detail: `cannot parse public_key_pem: ${e.message}` });
  }

  let signatureBuf;
  try {
    signatureBuf = Buffer.from(signature, 'base64');
    if (signatureBuf.length === 0) throw new Error('empty signature bytes');
  } catch (e) {
    return fail('malformed_input', inputHash, { detail: `cannot decode signature: ${e.message}` });
  }

  const payloadCanonical = canonicalJson(payload);
  const payloadBytes = Buffer.from(payloadCanonical, 'utf8');
  const payloadHash = sha256Hex(payloadCanonical);
  const publicKeyHash = sha256Hex(public_key_pem);

  let valid;
  try {
    valid = cryptoVerifyDispatch(algorithm, payloadBytes, publicKey, signatureBuf);
  } catch (e) {
    return fail('malformed_input', inputHash, { detail: `verify error: ${e.message}` });
  }

  const outputHash = sha256Hex(`${algorithm}:${valid ? 'valid' : 'invalid'}:${payloadHash}:${publicKeyHash}`);
  const details = {
    algorithm,
    payload_canonical_sha256: payloadHash,
    public_key_sha256: publicKeyHash,
  };

  if (valid) {
    return {
      decision: 'pass',
      reason: 'signature_valid',
      input_hash: inputHash,
      output_hash: outputHash,
      details,
    };
  }
  return {
    decision: 'fail',
    reason: 'signature_invalid',
    input_hash: inputHash,
    output_hash: outputHash,
    details,
  };
}

function cryptoVerifyDispatch(algorithm, payloadBytes, publicKey, signatureBuf) {
  if (algorithm === 'ed25519') {
    return cryptoVerify(null, payloadBytes, publicKey, signatureBuf);
  }
  throw new Error(`unreachable: unsupported algorithm ${algorithm}`);
}

function fail(reason, inputHash, details) {
  return {
    decision: 'fail',
    reason,
    input_hash: inputHash,
    output_hash: sha256Hex(`fail:${reason}:${inputHash || ''}`),
    details,
  };
}

function safeInputHash(input) {
  try {
    return sha256Hex(canonicalJson(input ?? null));
  } catch {
    return sha256Hex('unhashable');
  }
}

function sha256Hex(value) {
  const buf = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  return createHash('sha256').update(buf).digest('hex');
}
