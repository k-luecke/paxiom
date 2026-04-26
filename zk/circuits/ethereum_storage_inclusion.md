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
- A STARK/zkVM backend for Ethereum trie verification if Keccak/RLP costs dominate Circom.

## Exit Criteria

- Given an EIP-1186 proof, generate circuit inputs for account and storage paths.
- Verify account proof inclusion under a public state root.
- Verify storage proof inclusion under the account storage root.
- Compose with `uniswap_v3_slot0` decoding into one receipt.
