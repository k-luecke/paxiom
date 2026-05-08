// ethereum-header-fixture-verifier-v0
//
// Replays a stored Ethereum block header fixture deterministically:
//   recomputed_block_hash = keccak256(rlp(header))
// and compares the recomputed hash to the caller-supplied
// claimed_block_hash.
//
// Reason codes (per chassis spec):
//   pass: ethereum_header_valid
//   fail: ethereum_header_mismatch | fixture_not_found | malformed_input | unsupported_fixture
//
// All paths issue a receipt so the audit chain stays uninterrupted.
// HTTP layer maps decision -> status.
//
// Boundary: this verifier proves stored Ethereum block header fixture
// replay only. It does not prove account state, storage state, live
// chain access, finality, sync committee verification, or MPT witnesses.
// Those land in subsequent verifiers.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { RLP } from '@ethereumjs/rlp';
import { keccak256 } from 'ethereum-cryptography/keccak.js';
import { canonicalJson } from '../canonical.mjs';

export const VERIFIER_NAME = 'ethereum-header-fixture-verifier-v0';
export const VERIFIER_VERSION = '0.1.0';
export const SUPPORTED_FIXTURE_KIND = 'ethereum-block-header-v0';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURE_DIR = join(here, '..', '..', 'fixtures');
const FIXTURE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;
const HASH32_PATTERN = /^0x[0-9a-f]{64}$/i;

const FIXED_LEN = {
  parent_hash: 32, ommers_hash: 32, coinbase: 20, state_root: 32,
  transactions_root: 32, receipts_root: 32, logs_bloom: 256,
  mix_hash: 32, nonce: 8,
};
const QUANTITY = new Set(['difficulty', 'number', 'gas_limit', 'gas_used', 'timestamp']);
const VARLEN = new Set(['extra_data']);
const RLP_ORDER = [
  'parent_hash', 'ommers_hash', 'coinbase', 'state_root',
  'transactions_root', 'receipts_root', 'logs_bloom',
  'difficulty', 'number', 'gas_limit', 'gas_used', 'timestamp',
  'extra_data', 'mix_hash', 'nonce',
];

export function verify(input, options = {}) {
  const fixtureDir = options.fixtureDir
    || process.env.PAXIOM_LOCAL_VERIFIER_FIXTURE_DIR
    || DEFAULT_FIXTURE_DIR;
  const inputHash = safeInputHash(input);

  if (!input || typeof input !== 'object') {
    return fail('malformed_input', inputHash, { detail: 'input must be a JSON object' });
  }
  const { fixture_id, claimed_block_hash } = input;
  if (typeof fixture_id !== 'string' || fixture_id.length === 0) {
    return fail('malformed_input', inputHash, { detail: 'field "fixture_id" must be a non-empty string' });
  }
  if (!FIXTURE_ID_PATTERN.test(fixture_id)) {
    return fail('malformed_input', inputHash, {
      detail: 'fixture_id must match /^[a-z0-9][a-z0-9_-]*$/i (no path separators)',
    });
  }
  if (typeof claimed_block_hash !== 'string' || !HASH32_PATTERN.test(claimed_block_hash)) {
    return fail('malformed_input', inputHash, {
      detail: 'field "claimed_block_hash" must be 0x-prefixed 32-byte hex',
    });
  }

  const fixturePath = join(fixtureDir, `${fixture_id}.json`);
  if (!existsSync(fixturePath)) {
    return fail('fixture_not_found', inputHash, { fixture_id, fixture_dir: fixtureDir });
  }

  let fixture;
  try {
    fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  } catch (e) {
    return fail('unsupported_fixture', inputHash, { detail: `fixture is not valid JSON: ${e.message}` });
  }
  if (!fixture || typeof fixture !== 'object') {
    return fail('unsupported_fixture', inputHash, { detail: 'fixture file is not a JSON object' });
  }
  if (fixture.fixture_id !== fixture_id) {
    return fail('unsupported_fixture', inputHash, {
      detail: `fixture_id mismatch: file declares "${fixture.fixture_id}", request asked for "${fixture_id}"`,
    });
  }
  if (fixture.fixture_kind !== SUPPORTED_FIXTURE_KIND) {
    return fail('unsupported_fixture', inputHash, {
      detail: `unsupported fixture_kind: "${fixture.fixture_kind}" (expected "${SUPPORTED_FIXTURE_KIND}")`,
    });
  }
  const header = fixture.header;
  if (!header || typeof header !== 'object') {
    return fail('unsupported_fixture', inputHash, { detail: 'fixture missing "header" object' });
  }
  for (const f of RLP_ORDER) {
    if (typeof header[f] !== 'string') {
      return fail('unsupported_fixture', inputHash, {
        detail: `fixture.header.${f} is missing or not a hex string`,
      });
    }
  }
  if (typeof fixture.block_hash !== 'string' || !HASH32_PATTERN.test(fixture.block_hash)) {
    return fail('unsupported_fixture', inputHash, {
      detail: 'fixture.block_hash must be 0x-prefixed 32-byte hex',
    });
  }

  let rlpInput;
  try {
    rlpInput = RLP_ORDER.map((f) => encodeField(f, header[f]));
  } catch (e) {
    return fail('unsupported_fixture', inputHash, { detail: e.message });
  }

  let recomputedHex;
  try {
    const encoded = RLP.encode(rlpInput);
    recomputedHex = '0x' + Buffer.from(keccak256(encoded)).toString('hex');
  } catch (e) {
    return fail('unsupported_fixture', inputHash, { detail: `RLP/keccak failed: ${e.message}` });
  }

  const recomputed = recomputedHex.toLowerCase();
  const claimed = claimed_block_hash.toLowerCase();
  const fixtureDeclared = fixture.block_hash.toLowerCase();

  const details = {
    fixture_id,
    fixture_kind: fixture.fixture_kind,
    fixture_block_hash: fixtureDeclared,
    recomputed_block_hash: recomputed,
    claimed_block_hash: claimed,
    fixture_consistent: fixtureDeclared === recomputed,
  };
  const outputHash = sha256Hex(`${fixture_id}:${recomputed}:${claimed}`);

  if (claimed === recomputed) {
    return {
      decision: 'pass',
      reason: 'ethereum_header_valid',
      input_hash: inputHash,
      output_hash: outputHash,
      details,
    };
  }
  return {
    decision: 'fail',
    reason: 'ethereum_header_mismatch',
    input_hash: inputHash,
    output_hash: outputHash,
    details,
  };
}

function encodeField(name, hex) {
  if (FIXED_LEN[name] !== undefined) {
    const bytes = hexToBytesStrict(hex, name);
    if (bytes.length !== FIXED_LEN[name]) {
      throw new Error(`field ${name} must be exactly ${FIXED_LEN[name]} bytes, got ${bytes.length}`);
    }
    return bytes;
  }
  if (QUANTITY.has(name)) return stripLeadingZeros(hexToBytesQuantity(hex, name));
  if (VARLEN.has(name)) return hexToBytesStrict(hex, name);
  throw new Error(`unknown header field: ${name}`);
}

// Strict: rejects odd-length hex. For fixed-length fields and variable byte-strings
// where the bit representation must be exact (hashes, addresses, bloom, nonce, extra_data).
function hexToBytesStrict(hex, fieldName) {
  if (typeof hex !== 'string' || !/^0x[0-9a-f]*$/i.test(hex)) {
    throw new Error(`field ${fieldName}: not a 0x-prefixed hex string`);
  }
  const s = hex.slice(2);
  if (s.length % 2 !== 0) throw new Error(`field ${fieldName}: odd-length hex`);
  return decodeHex(s);
}

// Lenient: accepts canonical Ethereum quantity hex (e.g. "0x0", "0x1c9c380").
// Odd-length input is left-padded with a single zero nibble before decoding.
function hexToBytesQuantity(hex, fieldName) {
  if (typeof hex !== 'string' || !/^0x[0-9a-f]*$/i.test(hex)) {
    throw new Error(`field ${fieldName}: not a 0x-prefixed hex string`);
  }
  let s = hex.slice(2);
  if (s.length % 2 !== 0) s = '0' + s;
  return decodeHex(s);
}

function decodeHex(s) {
  if (s.length === 0) return new Uint8Array(0);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function stripLeadingZeros(bytes) {
  let i = 0;
  while (i < bytes.length && bytes[i] === 0) i++;
  return bytes.slice(i);
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
