// MPT proof verification for load.network responses.
//
// The substantive question this module answers: "given an EIP-1186 proof
// from load.network, does the proof actually chain from the leaf back to
// the claimed root, and does the leaf hold the value the response claims?"
//
// All functions here are PURE — no I/O, no global state. They take bytes
// and a root, return verified bytes or throw LoadNetworkVerificationError
// with a stable `reason` string so downstream logging/metrics can group
// on it without sniffing text.
//
// The cryptographic primitives (keccak256, RLP, MPT walk) come from
// @ethereumjs/{trie,util,rlp} and ethereum-cryptography. We deliberately
// do not roll our own — getting Ethereum trie semantics right (compact
// nibble encoding, branch vs extension vs leaf nodes, RLP framing) is a
// known footgun and the reference implementations are well-audited.
//
// The downstream caller of choice is `reconstruct.mjs`. The Service 01
// ZK witness consumer also uses these functions to validate inputs
// before they enter the circuit.

import { Trie } from '@ethereumjs/trie';
import { RLP } from '@ethereumjs/rlp';
import {
  bytesToHex,
  hexToBytes,
  equalsBytes,
  concatBytes,
  setLengthLeft,
  bigIntToBytes,
} from '@ethereumjs/util';
import { keccak256 } from 'ethereum-cryptography/keccak.js';

import { LoadNetworkVerificationError, VerificationReasons } from './errors.mjs';

// ─── Helpers ────────────────────────────────────────────────────────────

function asBytes(input, label) {
  if (input instanceof Uint8Array) return input;
  if (typeof input === 'string') return hexToBytes(input.startsWith('0x') ? input : '0x' + input);
  throw new LoadNetworkVerificationError(`${label}: expected hex string or Uint8Array`, {
    reason: VerificationReasons.PROOF_INVALID,
  });
}

function as32Bytes(input, label) {
  const b = asBytes(input, label);
  if (b.length !== 32) {
    throw new LoadNetworkVerificationError(`${label}: expected 32 bytes, got ${b.length}`, {
      reason: VerificationReasons.PROOF_INVALID,
    });
  }
  return b;
}

function decodeProof(proof) {
  if (!Array.isArray(proof)) {
    throw new LoadNetworkVerificationError('proof: expected array of trie nodes', {
      reason: VerificationReasons.PROOF_INVALID,
    });
  }
  if (proof.length === 0) {
    throw new LoadNetworkVerificationError('proof: empty', {
      reason: VerificationReasons.EMPTY_PROOF,
    });
  }
  return proof.map((node, i) => asBytes(node, `proof[${i}]`));
}

// Storage slot key derivation per Ethereum yellow paper §4.1:
// trie key = keccak256(slot padded to 32 bytes, big-endian).
export function deriveStorageKey(slotHexOrBytes) {
  let slotBytes;
  if (typeof slotHexOrBytes === 'string') {
    const hex = slotHexOrBytes.startsWith('0x') ? slotHexOrBytes.slice(2) : slotHexOrBytes;
    slotBytes = hexToBytes('0x' + hex.padStart(64, '0'));
  } else {
    slotBytes = setLengthLeft(slotHexOrBytes, 32);
  }
  return keccak256(slotBytes);
}

// World state trie key for an account: keccak256(20-byte address).
export function deriveAccountKey(addressHexOrBytes) {
  const bytes = asBytes(addressHexOrBytes, 'address');
  if (bytes.length !== 20) {
    throw new LoadNetworkVerificationError(`address: expected 20 bytes, got ${bytes.length}`, {
      reason: VerificationReasons.PROOF_INVALID,
    });
  }
  return keccak256(bytes);
}

// Encode a storage slot value the way Ethereum does in the storage trie:
// strip leading zero bytes, then RLP-encode. Empty bytes encode as 0x80.
export function encodeStorageValue(valueHexOrBytes) {
  let raw = asBytes(valueHexOrBytes, 'storage value');
  let i = 0;
  while (i < raw.length && raw[i] === 0) i++;
  raw = raw.slice(i);
  return RLP.encode(raw);
}

// Encode an account the way Ethereum does in the world state trie:
// RLP([nonce, balance, storageRoot, codeHash]). Numeric fields are
// big-endian with leading zero bytes stripped.
export function encodeAccount({ nonce, balance, storageRoot, codeHash }) {
  return RLP.encode([
    bigIntToBytes(BigInt(nonce ?? 0n)),
    bigIntToBytes(BigInt(balance ?? 0n)),
    as32Bytes(storageRoot, 'storageRoot'),
    as32Bytes(codeHash, 'codeHash'),
  ]);
}

// ─── Core verifier ──────────────────────────────────────────────────────

// Walks an EIP-1186 proof: builds the sub-trie from the proof nodes,
// requires the resulting root to equal `rootHash`, then looks up `key`.
// Returns the recovered value bytes (or null for proof-of-absence).
//
// Throws LoadNetworkVerificationError with a stable `reason`.
async function walkProof({ rootHash, key, proof }) {
  const trie = await Trie.create();
  try {
    return await trie.verifyProof(rootHash, key, proof);
  } catch (e) {
    // The library distinguishes:
    //   "Invalid proof nodes given" → the proof's reconstructed root
    //     doesn't match the claimed rootHash.
    //   "Invalid proof provided"    → the key path doesn't terminate.
    if (typeof e?.message === 'string' && e.message.includes('Invalid proof nodes')) {
      throw new LoadNetworkVerificationError(
        `MPT proof root mismatch: proof does not chain to ${bytesToHex(rootHash)}`,
        {
          reason: VerificationReasons.PROOF_ROOT_MISMATCH,
          expectedRoot: bytesToHex(rootHash),
          key: bytesToHex(key),
          cause: e,
        },
      );
    }
    throw new LoadNetworkVerificationError(
      `MPT proof failed for key ${bytesToHex(key)}: ${e?.message ?? e}`,
      {
        reason: VerificationReasons.PROOF_INVALID,
        expectedRoot: bytesToHex(rootHash),
        key: bytesToHex(key),
        cause: e,
      },
    );
  }
}

// Verify an arbitrary trie proof (low-level entry point).
//
//   rootHash   – 32-byte buffer or 0x-prefixed hex
//   key        – the trie key (already keccak256'd if applicable)
//   value      – expected value bytes (or null to prove absence)
//   proof      – array of RLP-encoded trie node bytes (EIP-1186)
//
// Returns: { verified: true, recoveredValue, proofNodes, key, rootHash }
//   `proofNodes` is the proof in normalised Uint8Array form — handy as
//   ZK witness data, since the circuit consumes raw node bytes.
//
// Throws: LoadNetworkVerificationError on any failure.
export async function verifyTrieProof({ rootHash, key, value, proof }) {
  const root = as32Bytes(rootHash, 'rootHash');
  const keyBytes = asBytes(key, 'key');
  const proofBytes = decodeProof(proof);

  const recovered = await walkProof({ rootHash: root, key: keyBytes, proof: proofBytes });

  // Value comparison is strict bytes-equal. Caller is responsible for
  // encoding `value` the same way the trie does (see encodeStorageValue
  // and encodeAccount above).
  if (value === null || value === undefined) {
    if (recovered !== null) {
      throw new LoadNetworkVerificationError(
        'expected proof of absence, but key resolved to a value',
        {
          reason: VerificationReasons.STORAGE_VALUE_MISMATCH,
          observedValue: bytesToHex(recovered),
          key: bytesToHex(keyBytes),
          expectedRoot: bytesToHex(root),
        },
      );
    }
  } else {
    const expected = asBytes(value, 'value');
    if (recovered === null) {
      throw new LoadNetworkVerificationError(
        'proof terminates in absence but caller expected a value',
        {
          reason: VerificationReasons.ACCOUNT_KEY_MISSING,
          expectedValue: bytesToHex(expected),
          key: bytesToHex(keyBytes),
          expectedRoot: bytesToHex(root),
        },
      );
    }
    if (!equalsBytes(recovered, expected)) {
      throw new LoadNetworkVerificationError(
        `value mismatch: expected ${bytesToHex(expected)}, recovered ${bytesToHex(recovered)}`,
        {
          reason: VerificationReasons.STORAGE_VALUE_MISMATCH,
          observedValue: bytesToHex(recovered),
          expectedValue: bytesToHex(expected),
          key: bytesToHex(keyBytes),
          expectedRoot: bytesToHex(root),
        },
      );
    }
  }

  return {
    verified: true,
    recoveredValue: recovered,
    proofNodes: proofBytes,
    key: keyBytes,
    rootHash: root,
  };
}

// Verify an account proof: state-root → encoded account at address.
// Returns the verified envelope plus a `path` field that holds the proof
// nodes — Service 01's ZK witness builder consumes this directly.
export async function verifyAccountProof({
  stateRoot, address, account, accountProof,
}) {
  const key = deriveAccountKey(address);
  const value = encodeAccount(account);
  const result = await verifyTrieProof({ rootHash: stateRoot, key, value, proof: accountProof });
  return {
    verified: true,
    address: typeof address === 'string' ? address.toLowerCase() : bytesToHex(address),
    account,
    stateRoot: result.rootHash,
    accountKey: result.key,
    path: result.proofNodes,
  };
}

// Verify a storage slot proof: storage-root → RLP(value) at slot.
export async function verifyStorageProof({
  storageRoot, slot, value, storageProof,
}) {
  const key = deriveStorageKey(slot);
  const expected = encodeStorageValue(value);
  const result = await verifyTrieProof({ rootHash: storageRoot, key, value: expected, proof: storageProof });
  return {
    verified: true,
    slot: typeof slot === 'string' ? slot : bytesToHex(slot),
    value: typeof value === 'string' ? value : bytesToHex(value),
    storageRoot: result.rootHash,
    storageKey: result.key,
    path: result.proofNodes,
  };
}

// Compose: verify both account and storage proofs in one call. This is
// what `reconstructStorageSlot` invokes under the hood; everything below
// the ZK witness layer should go through here so both proofs are checked
// before any value is returned to the caller.
export async function verifyAccountAndStorage({
  stateRoot, address, account, accountProof, slot, value, storageProof,
}) {
  const accountResult = await verifyAccountProof({
    stateRoot, address, account, accountProof,
  });
  const storageResult = await verifyStorageProof({
    storageRoot: account.storageRoot ?? account.storage_root,
    slot, value, storageProof,
  });
  return {
    verified: true,
    address: accountResult.address,
    slot: storageResult.slot,
    value: storageResult.value,
    stateRoot: accountResult.stateRoot,
    storageRoot: storageResult.storageRoot,
    account,
    witness: {
      accountKey: accountResult.accountKey,
      storageKey: storageResult.storageKey,
      accountProof: accountResult.path,
      storageProof: storageResult.path,
    },
  };
}

// Reasons re-export so callers can catch and group without a second import.
export { VerificationReasons } from './errors.mjs';

// Internal helpers exposed for the test suite (and only the test suite —
// callers should use the high-level verifyAccount/Storage entry points).
export const __internal = { decodeProof, walkProof, asBytes, as32Bytes };

// Tiny helper using @ethereumjs/util — kept here so consumers don't need
// a second import to stringify byte buffers consistently with our errors.
export { bytesToHex, hexToBytes, concatBytes };
