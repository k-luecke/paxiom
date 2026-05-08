// sync-committee-fixture-verifier-v0
//
// Verifies a stored Ethereum sync-committee update fixture
// deterministically. v0 covers fixture structure, SSZ-style domain and
// signing_root derivation, and participation counting.
//
// IMPORTANT: v0 does NOT perform BLS aggregate signature verification.
// `sync_aggregate.sync_committee_signature` is read but not validated.
// Every receipt's `details.bls_aggregate_verified` is `false` to make
// this explicit. Real BLS aggregate verification is the next slice
// (`sync-committee-bls-verifier-v1`); it would either shell out to the
// audited Rust binary at `bls-verifier/bls-verify-cli` or carefully
// match `@noble/curves/bls12-381` to Ethereum's min_pk +
// `BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_POP_` ciphersuite. Doing it
// without working real-data fixtures and without auditable parity to
// the Rust device would ship a JS BLS that "verifies against itself".
//
// The SSZ derivation in this file matches `bls-verify-cli/src/main.rs`
// (compute_domain + compute_signing_root) so the v1 BLS slice can sign
// over the same signing_root the Rust device computes.
//
// Reason codes (per chassis spec):
//   pass: sync_committee_valid
//   fail: sync_committee_invalid | header_root_mismatch
//         | participation_mismatch | fixture_not_found
//         | malformed_input | unsupported_fixture
//
// `signature_invalid` is reserved for v1 (BLS aggregate verification).
// v0 never emits it.
//
// Boundary: this verifier is fixture-only. It does not yet claim live
// Ethereum finality, live beacon-chain access, live canonicality, or
// archive-node retrieval.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../canonical.mjs';

export const VERIFIER_NAME = 'sync-committee-fixture-verifier-v0';
export const VERIFIER_VERSION = '0.1.0';
export const SUPPORTED_FIXTURE_KIND = 'ethereum-sync-committee-update-v0';
export const BLS_AGGREGATE_VERIFIED_IN_V0 = false;

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURE_DIR = join(here, '..', '..', 'fixtures');
const FIXTURE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;
const HASH32_PATTERN = /^0x[0-9a-f]{64}$/i;

const DOMAIN_SYNC_COMMITTEE = Buffer.from([0x07, 0x00, 0x00, 0x00]);

export function verify(input, options = {}) {
  const fixtureDir = options.fixtureDir
    || process.env.PAXIOM_LOCAL_VERIFIER_FIXTURE_DIR
    || DEFAULT_FIXTURE_DIR;
  const inputHash = safeInputHash(input);

  if (!input || typeof input !== 'object') {
    return fail('malformed_input', inputHash, { detail: 'input must be a JSON object' });
  }
  const { fixture_id, claimed_header_root, claimed_participation } = input;
  if (typeof fixture_id !== 'string' || !FIXTURE_ID_PATTERN.test(fixture_id)) {
    return fail('malformed_input', inputHash, {
      detail: 'fixture_id must match /^[a-z0-9][a-z0-9_-]*$/i',
    });
  }
  if (!HASH32_PATTERN.test(String(claimed_header_root || ''))) {
    return fail('malformed_input', inputHash, {
      detail: 'claimed_header_root must be 0x-prefixed 32-byte hex',
    });
  }
  if (!Number.isInteger(claimed_participation) || claimed_participation < 0) {
    return fail('malformed_input', inputHash, {
      detail: 'claimed_participation must be a non-negative integer',
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

  // Required structural fields.
  const required = [
    'slot', 'fork_version', 'genesis_validators_root',
    'block_root', 'parent_root', 'sync_aggregate', 'expected',
  ];
  for (const f of required) {
    if (!(f in fixture)) {
      return fail('unsupported_fixture', inputHash, { detail: `fixture missing field "${f}"` });
    }
  }
  const sa = fixture.sync_aggregate;
  if (!sa || typeof sa !== 'object'
      || typeof sa.sync_committee_bits !== 'string'
      || typeof sa.sync_committee_signature !== 'string') {
    return fail('unsupported_fixture', inputHash, {
      detail: 'fixture.sync_aggregate must include sync_committee_bits + sync_committee_signature hex strings',
    });
  }
  if (!HASH32_PATTERN.test(fixture.block_root) || !HASH32_PATTERN.test(fixture.parent_root)) {
    return fail('unsupported_fixture', inputHash, {
      detail: 'fixture.block_root and fixture.parent_root must be 0x-prefixed 32-byte hex',
    });
  }
  if (!/^0x[0-9a-f]{8}$/i.test(fixture.fork_version || '')) {
    return fail('unsupported_fixture', inputHash, { detail: 'fixture.fork_version must be 4-byte hex' });
  }
  if (!HASH32_PATTERN.test(fixture.genesis_validators_root)) {
    return fail('unsupported_fixture', inputHash, { detail: 'fixture.genesis_validators_root must be 32-byte hex' });
  }
  if (!fixture.expected || typeof fixture.expected !== 'object') {
    return fail('unsupported_fixture', inputHash, { detail: 'fixture.expected must be an object' });
  }

  // Recompute SSZ derivations.
  let domain, signingRoot, participation;
  try {
    domain = computeDomain(fixture.fork_version, fixture.genesis_validators_root);
    signingRoot = computeSigningRoot(fixture.parent_root, domain);
    participation = popcount(hexToBuf(sa.sync_committee_bits));
  } catch (e) {
    return fail('unsupported_fixture', inputHash, { detail: `recompute failed: ${e.message}` });
  }

  const recomputed = {
    domain: bufToHex(domain),
    signing_root: bufToHex(signingRoot),
    participation,
  };
  const expected = {
    domain: String(fixture.expected.domain || '').toLowerCase(),
    signing_root: String(fixture.expected.signing_root || '').toLowerCase(),
    participation: fixture.expected.participation,
  };

  const consistent = recomputed.domain === expected.domain
    && recomputed.signing_root === expected.signing_root
    && recomputed.participation === expected.participation;

  const baseDetails = {
    fixture_id,
    fixture_kind: fixture.fixture_kind,
    slot: String(fixture.slot),
    fork_version: String(fixture.fork_version).toLowerCase(),
    block_root: String(fixture.block_root).toLowerCase(),
    parent_root: String(fixture.parent_root).toLowerCase(),
    recomputed,
    expected,
    fixture_internally_consistent: consistent,
    bls_aggregate_verified: BLS_AGGREGATE_VERIFIED_IN_V0,
    bls_verification_note: 'sync-committee-fixture-verifier-v0 does not verify the BLS aggregate signature. sync_aggregate.sync_committee_signature is read but not validated. Real BLS aggregate verification is sync-committee-bls-verifier-v1.',
  };

  if (!consistent) {
    return fail('sync_committee_invalid', inputHash, {
      ...baseDetails,
      detail: 'fixture.expected does not match recomputed SSZ derivation (domain / signing_root / participation)',
    });
  }

  if (String(fixture.block_root).toLowerCase() !== String(claimed_header_root).toLowerCase()) {
    return fail('header_root_mismatch', inputHash, {
      ...baseDetails,
      claimed_header_root: String(claimed_header_root).toLowerCase(),
      fixture_block_root: String(fixture.block_root).toLowerCase(),
    });
  }

  if (claimed_participation !== participation) {
    return fail('participation_mismatch', inputHash, {
      ...baseDetails,
      claimed_participation,
    });
  }

  return {
    decision: 'pass',
    reason: 'sync_committee_valid',
    input_hash: inputHash,
    output_hash: outputHash(fixture_id, recomputed.signing_root, claimed_header_root, claimed_participation),
    details: {
      ...baseDetails,
      claimed_header_root: String(claimed_header_root).toLowerCase(),
      claimed_participation,
    },
  };
}

// SSZ derivation — matches bls-verify-cli/src/main.rs:compute_domain.
function computeDomain(forkVersionHex, genesisValidatorsRootHex) {
  const fv = hexToBuf(forkVersionHex);
  if (fv.length !== 4) throw new Error(`fork_version must be 4 bytes, got ${fv.length}`);
  const gvr = hexToBuf(genesisValidatorsRootHex);
  if (gvr.length !== 32) throw new Error(`genesis_validators_root must be 32 bytes, got ${gvr.length}`);
  const chunk1 = Buffer.alloc(32);
  fv.copy(chunk1, 0);
  const forkDataRoot = sha256(chunk1, gvr);
  return Buffer.concat([DOMAIN_SYNC_COMMITTEE, forkDataRoot.subarray(0, 28)]);
}

// SSZ derivation — matches bls-verify-cli/src/main.rs:compute_signing_root.
function computeSigningRoot(parentRootHex, domain) {
  const parentRoot = hexToBuf(parentRootHex);
  if (parentRoot.length !== 32) throw new Error('parent_root must be 32 bytes');
  return sha256(parentRoot, domain);
}

function popcount(buf) {
  let n = 0;
  for (const b of buf) {
    let v = b;
    while (v) { n += v & 1; v >>>= 1; }
  }
  return n;
}

function sha256(...chunks) {
  const h = createHash('sha256');
  for (const c of chunks) h.update(c);
  return h.digest();
}

function hexToBuf(hex) {
  const s = String(hex || '').replace(/^0x/i, '');
  if (s.length % 2 !== 0) throw new Error('odd-length hex');
  return Buffer.from(s, 'hex');
}

function bufToHex(buf) {
  return '0x' + Buffer.from(buf).toString('hex').toLowerCase();
}

function outputHash(...parts) {
  return sha256Hex(parts.map((p) => String(p).toLowerCase()).join(':'));
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
