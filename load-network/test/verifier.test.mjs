// Pure-function tests for the MPT verifier. Synthesised tries — no
// network access, no fixture brittleness. Round-trip semantics: build a
// trie with known values, ask the trie for a proof, hand the proof to
// the verifier, assert what comes back. Then perturb each input and
// assert the right `reason` string surfaces.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Trie } from '@ethereumjs/trie';
import { RLP } from '@ethereumjs/rlp';
import { bytesToHex, hexToBytes, bigIntToBytes, equalsBytes } from '@ethereumjs/util';
import { keccak256 } from 'ethereum-cryptography/keccak.js';

import {
  verifyTrieProof,
  verifyAccountProof,
  verifyStorageProof,
  verifyAccountAndStorage,
  deriveAccountKey,
  deriveStorageKey,
  encodeStorageValue,
  encodeAccount,
} from '../verifier.mjs';
import { LoadNetworkVerificationError, VerificationReasons } from '../errors.mjs';

// ─── Fixtures: built per-test from synthesised tries ──────────────────────

const ADDRESS = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const SLOT_0  = '0x0';
const SLOT_0_VALUE = '0x577261707065642045746865720000000000000000000000000000000000001a';

const ACCOUNT = {
  nonce: 1n,
  balance: 0n,
  storageRoot: null, // populated per-test from the synthesised storage trie
  codeHash:    '0xb44d950b2cf81c7c4e7b0e1c7bce3a3b1f3c5d7e9b1c3d5e7f9a1b3c5d7e9f12',
};

async function buildStorageTrie(entries) {
  const trie = await Trie.create();
  for (const [slot, value] of entries) {
    await trie.put(deriveStorageKey(slot), encodeStorageValue(value));
  }
  return trie;
}

async function buildStateTrie(entries) {
  const trie = await Trie.create();
  for (const [address, encodedAccount] of entries) {
    await trie.put(deriveAccountKey(address), encodedAccount);
  }
  return trie;
}

// ─── verifyStorageProof ───────────────────────────────────────────────────

test('verifyStorageProof: happy path round-trips a single slot', async () => {
  const trie = await buildStorageTrie([[SLOT_0, SLOT_0_VALUE]]);
  const root = trie.root();
  const proof = await trie.createProof(deriveStorageKey(SLOT_0));

  const r = await verifyStorageProof({
    storageRoot: root, slot: SLOT_0, value: SLOT_0_VALUE, storageProof: proof,
  });

  assert.equal(r.verified, true);
  assert.equal(r.slot, SLOT_0);
  assert.equal(r.value, SLOT_0_VALUE);
  assert.ok(equalsBytes(r.storageRoot, root));
  assert.ok(Array.isArray(r.path));
  assert.equal(r.path.length, proof.length);
});

test('verifyStorageProof: works for tries with many entries', async () => {
  const entries = Array.from({ length: 16 }, (_, i) =>
    [`0x${i.toString(16)}`, '0x' + (i + 1).toString(16).padStart(64, '0')]);
  const trie = await buildStorageTrie(entries);
  const root = trie.root();

  // Verify several slots from the same trie
  for (const [slot, value] of entries.slice(0, 4)) {
    const proof = await trie.createProof(deriveStorageKey(slot));
    const r = await verifyStorageProof({ storageRoot: root, slot, value, storageProof: proof });
    assert.equal(r.verified, true);
    assert.equal(r.slot, slot);
  }
});

test('verifyStorageProof: rejects wrong storage root', async () => {
  const trie = await buildStorageTrie([[SLOT_0, SLOT_0_VALUE]]);
  const proof = await trie.createProof(deriveStorageKey(SLOT_0));
  const wrongRoot = keccak256(new TextEncoder().encode('not the real root'));

  await assert.rejects(
    () => verifyStorageProof({ storageRoot: wrongRoot, slot: SLOT_0, value: SLOT_0_VALUE, storageProof: proof }),
    (e) => e instanceof LoadNetworkVerificationError
        && e.reason === VerificationReasons.PROOF_ROOT_MISMATCH,
  );
});

test('verifyStorageProof: rejects mismatched value', async () => {
  const trie = await buildStorageTrie([[SLOT_0, SLOT_0_VALUE]]);
  const root = trie.root();
  const proof = await trie.createProof(deriveStorageKey(SLOT_0));

  await assert.rejects(
    () => verifyStorageProof({ storageRoot: root, slot: SLOT_0, value: '0x' + 'ff'.repeat(32), storageProof: proof }),
    (e) => e.reason === VerificationReasons.STORAGE_VALUE_MISMATCH,
  );
});

test('verifyStorageProof: rejects empty proof array', async () => {
  await assert.rejects(
    () => verifyStorageProof({
      storageRoot: '0x' + 'aa'.repeat(32),
      slot: SLOT_0, value: SLOT_0_VALUE, storageProof: [],
    }),
    (e) => e.reason === VerificationReasons.EMPTY_PROOF,
  );
});

test('verifyStorageProof: rejects tampered proof node', async () => {
  const trie = await buildStorageTrie([[SLOT_0, SLOT_0_VALUE]]);
  const root = trie.root();
  const proof = await trie.createProof(deriveStorageKey(SLOT_0));
  // Flip the last byte of the last node
  const tampered = proof.map((n) => new Uint8Array(n));
  const last = tampered[tampered.length - 1];
  last[last.length - 1] ^= 0xff;

  await assert.rejects(
    () => verifyStorageProof({ storageRoot: root, slot: SLOT_0, value: SLOT_0_VALUE, storageProof: tampered }),
    (e) => e instanceof LoadNetworkVerificationError,
  );
});

// ─── verifyAccountProof ───────────────────────────────────────────────────

test('verifyAccountProof: happy path round-trips an account leaf', async () => {
  // Build a storage trie first to get a real storageRoot for the account
  const storageTrie = await buildStorageTrie([[SLOT_0, SLOT_0_VALUE]]);
  const account = { ...ACCOUNT, storageRoot: storageTrie.root() };
  const stateTrie = await buildStateTrie([[ADDRESS, encodeAccount(account)]]);
  const stateRoot = stateTrie.root();
  const accountProof = await stateTrie.createProof(deriveAccountKey(ADDRESS));

  const r = await verifyAccountProof({
    stateRoot, address: ADDRESS, account, accountProof,
  });
  assert.equal(r.verified, true);
  assert.equal(r.address, ADDRESS);
  assert.ok(Array.isArray(r.path));
});

test('verifyAccountProof: rejects mismatched account fields', async () => {
  const storageTrie = await buildStorageTrie([[SLOT_0, SLOT_0_VALUE]]);
  const account = { ...ACCOUNT, storageRoot: storageTrie.root() };
  const stateTrie = await buildStateTrie([[ADDRESS, encodeAccount(account)]]);
  const accountProof = await stateTrie.createProof(deriveAccountKey(ADDRESS));

  // Tamper with the nonce: same proof, different claimed account
  const wrong = { ...account, nonce: 999n };
  await assert.rejects(
    () => verifyAccountProof({
      stateRoot: stateTrie.root(), address: ADDRESS, account: wrong, accountProof,
    }),
    (e) => e.reason === VerificationReasons.STORAGE_VALUE_MISMATCH,
  );
});

// ─── verifyAccountAndStorage (composed) ───────────────────────────────────

test('verifyAccountAndStorage: composed account + storage proof', async () => {
  const storageTrie = await buildStorageTrie([[SLOT_0, SLOT_0_VALUE]]);
  const account = { ...ACCOUNT, storageRoot: storageTrie.root() };
  const stateTrie = await buildStateTrie([[ADDRESS, encodeAccount(account)]]);
  const accountProof = await stateTrie.createProof(deriveAccountKey(ADDRESS));
  const storageProof = await storageTrie.createProof(deriveStorageKey(SLOT_0));

  const r = await verifyAccountAndStorage({
    stateRoot: stateTrie.root(),
    address: ADDRESS,
    account,
    accountProof,
    slot: SLOT_0,
    value: SLOT_0_VALUE,
    storageProof,
  });

  assert.equal(r.verified, true);
  assert.equal(r.address, ADDRESS);
  assert.equal(r.slot, SLOT_0);
  assert.equal(r.value, SLOT_0_VALUE);
  // The witness shape is what Service 01's ZK circuit consumes
  assert.ok(r.witness.accountKey instanceof Uint8Array);
  assert.ok(r.witness.storageKey instanceof Uint8Array);
  assert.ok(Array.isArray(r.witness.accountProof));
  assert.ok(Array.isArray(r.witness.storageProof));
});

test('verifyAccountAndStorage: storage proof against wrong storageRoot fails', async () => {
  const realStorage = await buildStorageTrie([[SLOT_0, SLOT_0_VALUE]]);
  const fakeStorage = await buildStorageTrie([[SLOT_0, '0x' + 'ee'.repeat(32)]]);
  const account = { ...ACCOUNT, storageRoot: fakeStorage.root() };
  const stateTrie = await buildStateTrie([[ADDRESS, encodeAccount(account)]]);
  const accountProof = await stateTrie.createProof(deriveAccountKey(ADDRESS));
  // Use the real storage trie's proof against the fake storage root in the account
  const storageProof = await realStorage.createProof(deriveStorageKey(SLOT_0));

  await assert.rejects(
    () => verifyAccountAndStorage({
      stateRoot: stateTrie.root(),
      address: ADDRESS,
      account,
      accountProof,
      slot: SLOT_0,
      value: SLOT_0_VALUE,
      storageProof,
    }),
    (e) => e.reason === VerificationReasons.PROOF_ROOT_MISMATCH,
  );
});

// ─── deriveAccountKey / deriveStorageKey ──────────────────────────────────

test('deriveStorageKey: matches keccak256 of left-padded slot', () => {
  // slot 0 → keccak256(0x00…00)
  const expected = keccak256(new Uint8Array(32));
  assert.ok(equalsBytes(deriveStorageKey('0x0'), expected));
  assert.ok(equalsBytes(deriveStorageKey('0x00'), expected));
});

test('deriveAccountKey: rejects non-20-byte address', () => {
  assert.throws(
    () => deriveAccountKey('0xdeadbeef'),
    (e) => e instanceof LoadNetworkVerificationError,
  );
});
