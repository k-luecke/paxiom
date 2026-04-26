# Ethereum Storage Inclusion Circuit Plan

The current live ZK lane proves the Uniswap V3 `slot0` decoding relation and binds the
off-circuit EIP-1186/MPT proof hash into the ZK job witness commitment.

The next circuit layer moves storage inclusion into the proof.

## Target Statement

For a finalized Ethereum block:

```text
public:
  state_root
  contract_address
  storage_slot
  storage_value
  predicate_public_outputs

private:
  account_proof_nodes
  storage_proof_nodes
  account_rlp_fields
  storage_rlp_fields
```

Prove:

```text
contract_account is included under state_root
contract_account.storageRoot is extracted from account RLP
storage_slot key is included under storageRoot
storage_value is extracted from the storage leaf
predicate_public_outputs are derived from storage_value
```

## Hard Parts

- Keccak inside the proof system.
- Hex-prefix trie path decoding.
- RLP decoding for account and storage proof nodes.
- Variable-length proof paths.
- Empty/non-existence proof semantics for future predicates.

## Near-Term Circuit Interface

Paxiom now has a backend-neutral normalized witness command:

```sh
npm run zk:witness:inclusion -- --address=0x... --slot=0x0 --block=finalized
```

It writes `.paxiom-runtime/ethereum-inclusion-witness.json` with:

- public state root, account hash, storage root, storage key hash, and storage value,
- raw account and storage proof nodes,
- each proof node's Keccak hash,
- decoded branch/extension/leaf metadata,
- root checks against the block state root and account storage hash,
- the exact circuit target statement for Keccak + RLP + MPT.

Until the full trie verifier lands, every ZK predicate receipt must include:

```json
{
  "mpt_proof_hash": "...",
  "witness_commitment": "...",
  "state_root": "...",
  "block_number": 0
}
```

This keeps the current lane honest: the MPT proof is verified outside-circuit and committed into
the ZK job. The full in-circuit version replaces `mpt_proof_hash` with public trie verification.

## Candidate Proving Backends

- Groth16/Circom for small predicate relation proofs.
- RapidSnark for accelerated Groth16 proving once witness generation is separated.
- Goldilocks/STARK-style proving for high-throughput Ethereum inclusion work.
- A STARK/zkVM backend for Ethereum trie verification if Keccak/RLP costs dominate Circom.

Reference scan:

- `vocdoni/keccak256-circom` has an Ethereum Keccak Circom implementation, but it is GPL-3.0
  and should not be vendored into Paxiom without accepting that license boundary.
- `worm-privacy/proof-of-burn` has MIT-licensed Keccak/RLP/MPT circuit patterns, including
  trie layer hashing, leaf detection, and substring checks. It is account-inclusion-shaped,
  not a drop-in storage inclusion verifier.

## Exit Criteria

- Given an EIP-1186 proof, generate circuit inputs for account and storage paths.
- Verify account proof inclusion under a public state root.
- Verify storage proof inclusion under the account storage root.
- Compose with `uniswap_v3_slot0` decoding into one receipt.

Current status:

- First criterion is implemented as an exact witness generator.
- Root hashing and full EIP-1186 verification are still performed off-circuit.
- `sdk/ethereum-inclusion-backend.cjs` defines the backend handoff and intentionally refuses
  non-mock backends until Keccak/RLP/MPT constraints are wired.
