# Paxiom Proof Corpus

The proof corpus is the bridge between the long-term cryptographic goal and the current AO execution layer. It models Ethereum history as a contiguous sequence of verifiable segments that can be recursively aggregated and queried for facts.

## Objects

### Genesis Anchor

The genesis anchor is the only root trust input.

```json
{
  "kind": "GENESIS_ANCHOR",
  "chain": "ethereum",
  "slot": 0,
  "block_number": 0,
  "state_root": "0x...",
  "commitment": "..."
}
```

### Segment Proof

A segment proof proves a bounded transition:

```text
from_slot, from_state_root -> to_slot, to_state_root
```

The current implementation stores deterministic commitments and proof metadata. Real ZK outputs plug into `proof_hash`, `proof_system`, and `public_inputs`.

### Aggregate Proof

An aggregate proof folds ordered, contiguous segment proofs into one corpus head. The aggregate is rejected if any segment has a slot gap or state-root gap.

### Fact Proof

A fact proof binds a useful predicate to a corpus commitment:

```text
At slot S under state root R, predicate P(subject) = value.
```

Examples:

- `storage_equals`
- `event_emitted`
- `account_balance_at_least`
- `aave_health_factor_below`
- `bundle_satisfies_constraints`

This is the first monetizable surface: protocols, solvers, bridges, liquidators, and wallets can consume compact proofs of Ethereum facts without trusting an indexer or relay layer.

## AO Process Contract

`ao-processes/proof-corpus.lua` exposes:

- `InitializeGenesis`
- `SubmitSegmentProof`
- `SubmitFactProof`
- `GetCorpusState`
- `GetFact`

The AO process enforces contiguous segment submission and fact binding to the latest corpus commitment.

## Local Demo

```bash
npm run proof:demo
```

This emits a demo genesis anchor, two segment proofs, a recursive aggregate placeholder, a fact proof, and the final corpus commitment.

## Real Ethereum Fact Proof

```bash
npm run proof:storage -- --address=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 --slot=0x0 --block=finalized
```

This fetches an EIP-1186 account/storage proof from an Ethereum RPC and verifies the Merkle Patricia proof locally against the block `stateRoot`. The resulting fact uses:

```text
proof_system = "eip1186-mpt"
predicate    = "storage_equals"
```

This is a real state proof, not a ZK proof. It proves a storage value opens under a known Ethereum state root. The remaining trust question is how that state root became known canonical Ethereum history; that is what the genesis-to-present recursive corpus is designed to remove.

## Live Ethereum Prover

```bash
npm run proof:live
```

The live prover continuously polls Ethereum finalized blocks and emits `ethereum-header-continuity` segment receipts. With `PAXIOM_PROOF_CORPUS_PROCESS` set, it submits segments to the AO proof-corpus process.

Useful environment variables:

- `ETH_RPC_URL`
- `PAXIOM_PROOF_CORPUS_PROCESS`
- `AR_WALLET`
- `PAXIOM_LIVE_BLOCK_TAG=finalized`
- `PAXIOM_LIVE_POLL_MS=12000`
- `PAXIOM_WATCH_ADDRESS`
- `PAXIOM_WATCH_SLOT`

Header-continuity receipts are an operator scaffold for live proving. They validate parent linkage and commit to block roots, but they are not a substitute for execution-layer state transition proofs or consensus proofs.
