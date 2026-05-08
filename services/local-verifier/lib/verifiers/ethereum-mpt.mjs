// ethereum-mpt-fixture-verifier-v0
//
// Verifies stored Ethereum-shaped Merkle Patricia Trie proof fixtures
// against a caller-supplied root. Reuses the audited proof walker in
// load-network/verifier.mjs (same code path Service 01's ZK witness
// builder consumes) rather than reimplementing trie semantics — getting
// nibble encoding / branch / extension / leaf nodes right is a known
// footgun.
//
// Two proof types in this slice:
//   "account" — caller supplies claimed_state_root + claimed_account_address.
//               Verifier walks the account_proof and confirms the recovered
//               account encoding matches the fixture's declared account
//               fields (nonce, balance, storage_root, code_hash).
//   "storage" — caller supplies claimed_storage_root + claimed_account_address
//               + claimed_storage_slot + claimed_storage_value. Verifier
//               walks the storage_proof and confirms recovered value bytes
//               match the caller's claim (and that the fixture's address /
//               slot / value agree).
//
// Reason codes (per chassis spec):
//   pass: mpt_account_proof_valid | mpt_storage_proof_valid
//   fail: mpt_proof_invalid | state_root_mismatch | fixture_not_found
//         | malformed_input | unsupported_fixture
//
// state_root_mismatch is used for both root-mismatch flavours
// (account proof not chaining to claimed_state_root, storage proof not
// chaining to claimed_storage_root); details.claimed_root indicates which.
//
// Boundary: this verifier proves deterministic fixture replay of
// MPT-shaped evidence only. It does not yet prove live Ethereum state,
// canonical chain inclusion, finality, sync committee verification, or
// archive-node retrieval. Those are subsequent verifiers.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { hexToBytes } from '@ethereumjs/util';
import {
  verifyAccountProof,
  verifyStorageProof,
  VerificationReasons,
} from '../../../../load-network/verifier.mjs';
import { canonicalJson } from '../canonical.mjs';

export const VERIFIER_NAME = 'ethereum-mpt-fixture-verifier-v0';
export const VERIFIER_VERSION = '0.1.0';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURE_DIR = join(here, '..', '..', '..', '..', 'load-network', 'fixtures');
const FIXTURE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;
const HASH32_PATTERN = /^0x[0-9a-f]{64}$/i;
const ADDR20_PATTERN = /^0x[0-9a-f]{40}$/i;
const HEX_PATTERN = /^0x[0-9a-f]*$/i;

export async function verify(input, options = {}) {
  const fixtureDir = options.fixtureDir
    || process.env.PAXIOM_LOCAL_VERIFIER_MPT_FIXTURE_DIR
    || DEFAULT_FIXTURE_DIR;
  const inputHash = safeInputHash(input);

  if (!input || typeof input !== 'object') {
    return fail('malformed_input', inputHash, { detail: 'input must be a JSON object' });
  }
  const { proof_type, fixture_id } = input;
  if (proof_type !== 'account' && proof_type !== 'storage') {
    return fail('malformed_input', inputHash, {
      detail: 'proof_type must be "account" or "storage"',
    });
  }
  if (typeof fixture_id !== 'string' || !FIXTURE_ID_PATTERN.test(fixture_id)) {
    return fail('malformed_input', inputHash, {
      detail: 'fixture_id must match /^[a-z0-9][a-z0-9_-]*$/i',
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

  if (proof_type === 'account') {
    return verifyAccount(input, fixture, fixture_id, inputHash);
  }
  return verifyStorage(input, fixture, fixture_id, inputHash);
}

async function verifyAccount(input, fixture, fixture_id, inputHash) {
  const { claimed_state_root, claimed_account_address } = input;
  if (!HASH32_PATTERN.test(String(claimed_state_root || ''))) {
    return fail('malformed_input', inputHash, { detail: 'claimed_state_root must be 0x-prefixed 32-byte hex' });
  }
  if (!ADDR20_PATTERN.test(String(claimed_account_address || ''))) {
    return fail('malformed_input', inputHash, { detail: 'claimed_account_address must be 0x-prefixed 20-byte hex' });
  }

  const required = ['address', 'balance', 'nonce', 'code_hash', 'storage_root', 'account_proof'];
  for (const f of required) {
    if (!(f in fixture)) {
      return fail('unsupported_fixture', inputHash, {
        detail: `fixture missing required field "${f}" for account proof`,
      });
    }
  }
  if (!Array.isArray(fixture.account_proof) || fixture.account_proof.length === 0) {
    return fail('unsupported_fixture', inputHash, { detail: 'fixture.account_proof must be a non-empty array' });
  }

  if (String(fixture.address).toLowerCase() !== claimed_account_address.toLowerCase()) {
    return fail('mpt_proof_invalid', inputHash, {
      detail: 'fixture.address does not match claimed_account_address',
      fixture_address: String(fixture.address).toLowerCase(),
      claimed_account_address: claimed_account_address.toLowerCase(),
    });
  }

  let result;
  try {
    result = await verifyAccountProof({
      stateRoot: hexToBytes(claimed_state_root),
      address: claimed_account_address,
      account: {
        nonce: BigInt(fixture.nonce),
        balance: BigInt(fixture.balance),
        storageRoot: fixture.storage_root,
        codeHash: fixture.code_hash,
      },
      accountProof: fixture.account_proof,
    });
  } catch (e) {
    return mapWalkerError(e, 'account', input, fixture_id, fixture, inputHash, claimed_state_root);
  }

  const details = {
    proof_type: 'account',
    fixture_id,
    claimed_state_root: claimed_state_root.toLowerCase(),
    claimed_account_address: claimed_account_address.toLowerCase(),
    fixture_address: String(fixture.address).toLowerCase(),
    fixture_storage_root: String(fixture.storage_root).toLowerCase(),
    proof_node_count: fixture.account_proof.length,
  };
  return {
    decision: 'pass',
    reason: 'mpt_account_proof_valid',
    input_hash: inputHash,
    output_hash: outputHash('account', fixture_id, claimed_state_root, claimed_account_address, true),
    details,
  };
}

async function verifyStorage(input, fixture, fixture_id, inputHash) {
  const {
    claimed_storage_root,
    claimed_account_address,
    claimed_storage_slot,
    claimed_storage_value,
  } = input;
  if (!HASH32_PATTERN.test(String(claimed_storage_root || ''))) {
    return fail('malformed_input', inputHash, { detail: 'claimed_storage_root must be 0x-prefixed 32-byte hex' });
  }
  if (!ADDR20_PATTERN.test(String(claimed_account_address || ''))) {
    return fail('malformed_input', inputHash, { detail: 'claimed_account_address must be 0x-prefixed 20-byte hex' });
  }
  if (typeof claimed_storage_slot !== 'string' || !HEX_PATTERN.test(claimed_storage_slot)) {
    return fail('malformed_input', inputHash, { detail: 'claimed_storage_slot must be 0x-prefixed hex' });
  }
  if (typeof claimed_storage_value !== 'string' || !HEX_PATTERN.test(claimed_storage_value)) {
    return fail('malformed_input', inputHash, { detail: 'claimed_storage_value must be 0x-prefixed hex' });
  }

  const required = ['address', 'slot', 'value', 'storage_proof'];
  for (const f of required) {
    if (!(f in fixture)) {
      return fail('unsupported_fixture', inputHash, {
        detail: `fixture missing required field "${f}" for storage proof`,
      });
    }
  }
  if (!Array.isArray(fixture.storage_proof) || fixture.storage_proof.length === 0) {
    return fail('unsupported_fixture', inputHash, { detail: 'fixture.storage_proof must be a non-empty array' });
  }
  if (String(fixture.address).toLowerCase() !== claimed_account_address.toLowerCase()) {
    return fail('mpt_proof_invalid', inputHash, {
      detail: 'fixture.address does not match claimed_account_address',
      fixture_address: String(fixture.address).toLowerCase(),
      claimed_account_address: claimed_account_address.toLowerCase(),
    });
  }
  if (normalizeSlot(fixture.slot) !== normalizeSlot(claimed_storage_slot)) {
    return fail('mpt_proof_invalid', inputHash, {
      detail: 'fixture.slot does not match claimed_storage_slot',
      fixture_slot: normalizeSlot(fixture.slot),
      claimed_storage_slot: normalizeSlot(claimed_storage_slot),
    });
  }

  let result;
  try {
    result = await verifyStorageProof({
      storageRoot: claimed_storage_root,
      slot: claimed_storage_slot,
      value: claimed_storage_value,
      storageProof: fixture.storage_proof,
    });
  } catch (e) {
    return mapWalkerError(e, 'storage', input, fixture_id, fixture, inputHash, claimed_storage_root);
  }

  // Cross-check: the fixture's declared value should match the caller's claim;
  // otherwise the fixture is being used to attest to a different value than
  // the caller asked about.
  if (String(fixture.value).toLowerCase() !== claimed_storage_value.toLowerCase()) {
    return fail('mpt_proof_invalid', inputHash, {
      detail: 'fixture.value does not match claimed_storage_value (proof chained, but caller claim differs from fixture)',
      fixture_value: String(fixture.value).toLowerCase(),
      claimed_storage_value: claimed_storage_value.toLowerCase(),
    });
  }

  const details = {
    proof_type: 'storage',
    fixture_id,
    claimed_storage_root: claimed_storage_root.toLowerCase(),
    claimed_account_address: claimed_account_address.toLowerCase(),
    claimed_storage_slot: normalizeSlot(claimed_storage_slot),
    claimed_storage_value: claimed_storage_value.toLowerCase(),
    proof_node_count: fixture.storage_proof.length,
  };
  return {
    decision: 'pass',
    reason: 'mpt_storage_proof_valid',
    input_hash: inputHash,
    output_hash: outputHash('storage', fixture_id, claimed_storage_root, claimed_storage_value, true),
    details,
  };
}

function mapWalkerError(e, proofType, input, fixture_id, fixture, inputHash, claimedRoot) {
  const reason = e?.reason;
  const detail = e?.message || String(e);
  const ctx = {
    proof_type: proofType,
    fixture_id,
    claimed_root: String(claimedRoot).toLowerCase(),
    walker_reason: reason,
    detail,
  };
  if (reason === VerificationReasons.PROOF_ROOT_MISMATCH) {
    return fail('state_root_mismatch', inputHash, ctx);
  }
  if (
    reason === VerificationReasons.PROOF_INVALID
    || reason === VerificationReasons.EMPTY_PROOF
    || reason === VerificationReasons.STORAGE_VALUE_MISMATCH
    || reason === VerificationReasons.ACCOUNT_VALUE_MISMATCH
    || reason === VerificationReasons.ACCOUNT_KEY_MISSING
  ) {
    return fail('mpt_proof_invalid', inputHash, ctx);
  }
  return fail('mpt_proof_invalid', inputHash, ctx);
}

function normalizeSlot(slot) {
  if (typeof slot !== 'string') return '';
  const s = slot.startsWith('0x') ? slot.slice(2) : slot;
  if (s.length === 0) return '0x0';
  // strip leading zero nibbles for stable comparison; preserve "0x0" for zero
  const stripped = s.replace(/^0+/, '') || '0';
  return '0x' + stripped.toLowerCase();
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
