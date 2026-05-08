#!/usr/bin/env node
// Generates the static MVP sync-committee update fixtures for
// sync-committee-fixture-verifier-v0.
//
//   node services/local-verifier/fixtures/make-sync-committee.mjs
//
// Produces:
//   sc-v0-period-1041-good.json      consistent: expected.* matches recompute
//   sc-v0-period-1041-tampered.json  expected.signing_root nibble-flipped
//
// SSZ-style domain + signing_root derivation matches bls-verify-cli/src/main.rs:
//   chunk1 = fork_version (4B) followed by 28 zero bytes (placed at start)
//   fork_data_root = sha256(chunk1 || genesis_validators_root)
//   domain = DOMAIN_SYNC_COMMITTEE (0x07000000) || fork_data_root[..28]
//   signing_root = sha256(parent_root || domain)
//
// NO real BLS aggregate signature is produced. sync_committee_signature
// is a labeled 96-byte placeholder. The fixture's purpose is to exercise
// the structural / SSZ portion of sync-committee verification
// deterministically. Full BLS aggregate verification is a future v1.

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const DOMAIN_SYNC_COMMITTEE = Buffer.from([0x07, 0x00, 0x00, 0x00]);
const COMMITTEE_BITS_LEN = 64; // 64 bytes = 512 bits = sync committee size
const COMMITTEE_SIG_LEN  = 96; // 96 bytes = BLS12-381 G2 signature

function sha256(...chunks) {
  const h = createHash('sha256');
  for (const c of chunks) h.update(c);
  return h.digest();
}
function hexToBuf(hex) {
  return Buffer.from(hex.startsWith('0x') ? hex.slice(2) : hex, 'hex');
}
function bufToHex(buf) {
  return '0x' + Buffer.from(buf).toString('hex');
}
function popcount(buf) {
  let n = 0;
  for (const b of buf) {
    let v = b;
    while (v) { n += v & 1; v >>>= 1; }
  }
  return n;
}

function computeDomain(forkVersionHex, genesisValidatorsRootHex) {
  const fv = hexToBuf(forkVersionHex);
  if (fv.length !== 4) throw new Error(`fork_version must be 4 bytes, got ${fv.length}`);
  const gvr = hexToBuf(genesisValidatorsRootHex);
  if (gvr.length !== 32) throw new Error(`genesis_validators_root must be 32 bytes, got ${gvr.length}`);
  const chunk1 = Buffer.alloc(32);
  fv.copy(chunk1, 0); // fork_version at start, rest = 0  (matches bls-verify-cli)
  const forkDataRoot = sha256(chunk1, gvr);
  return Buffer.concat([DOMAIN_SYNC_COMMITTEE, forkDataRoot.subarray(0, 28)]);
}

function computeSigningRoot(parentRootHex, domain) {
  const parentRoot = hexToBuf(parentRootHex);
  if (parentRoot.length !== 32) throw new Error('parent_root must be 32 bytes');
  return sha256(parentRoot, domain);
}

// Hand-built fixture inputs. Not from any real beacon chain.
const slot = '8421376';
const fork_version = '0x06000000';
const genesis_validators_root = '0x4b363db94e286120d76eb905340fdd4e54bfe9f06bf33ff6cf5ad27f511bfe95';
const block_root = '0x' + '11'.repeat(32);
const parent_root = '0x' + '22'.repeat(32);

// 384 of 512 bits set (3/4 — well above the 2/3 threshold).
const bits = Buffer.alloc(COMMITTEE_BITS_LEN);
for (let i = 0; i < 384; i++) {
  bits[Math.floor(i / 8)] |= (1 << (i % 8));
}
const sync_committee_bits = bufToHex(bits);
// 96-byte zero placeholder. Documented as not verified in v0.
const sync_committee_signature = '0x' + '00'.repeat(COMMITTEE_SIG_LEN);

const domain = computeDomain(fork_version, genesis_validators_root);
const signingRoot = computeSigningRoot(parent_root, domain);
const participation = popcount(bits);

const goodFixture = {
  fixture_id: 'sc-v0-period-1041-good',
  fixture_kind: 'ethereum-sync-committee-update-v0',
  description: 'Static MVP fixture: hand-built Ethereum sync-committee update with deterministic SSZ-style signing_root derivation. NO real BLS aggregate signature verification in v0; sync_committee_signature is a 96-byte zero placeholder.',
  slot,
  fork_version,
  genesis_validators_root,
  block_root,
  parent_root,
  sync_aggregate: {
    sync_committee_bits,
    sync_committee_signature,
  },
  expected: {
    domain: bufToHex(domain),
    signing_root: bufToHex(signingRoot),
    participation,
  },
  bls_verification: 'not_implemented_in_v0',
  note: 'Static MVP fixture. Deterministic. No live beacon chain. Regenerate via services/local-verifier/fixtures/make-sync-committee.mjs.',
};

function flipFirstNibble(hex) {
  const h = hex.slice(2);
  const first = parseInt(h[0], 16);
  return '0x' + (first ^ 0xf).toString(16) + h.slice(1);
}
const tamperedFixture = {
  ...goodFixture,
  fixture_id: 'sc-v0-period-1041-tampered',
  description: 'Static MVP fixture: same fields as sc-v0-period-1041-good, but expected.signing_root has its first nibble flipped. Verifier recomputes and reports sync_committee_invalid (fixture is internally inconsistent).',
  expected: {
    ...goodFixture.expected,
    signing_root: flipFirstNibble(goodFixture.expected.signing_root),
  },
};

writeFileSync(join(here, 'sc-v0-period-1041-good.json'), JSON.stringify(goodFixture, null, 2) + '\n');
writeFileSync(join(here, 'sc-v0-period-1041-tampered.json'), JSON.stringify(tamperedFixture, null, 2) + '\n');
console.log('wrote sc-v0-period-1041-good.json and sc-v0-period-1041-tampered.json');
console.log('domain:        ', bufToHex(domain));
console.log('signing_root:  ', bufToHex(signingRoot));
console.log('participation: ', participation);
