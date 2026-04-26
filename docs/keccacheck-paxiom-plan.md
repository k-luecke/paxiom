# Keccacheck Plan For Paxiom

Source reviewed:

```text
Keccacheck: towards a SNARK friendly Keccak
ePrint 2025/1764
Reilabs
```

Local text extraction:

```text
.paxiom-runtime/papers/2025-1764.txt
```

Upstream implementation:

```text
https://github.com/reilabs/keccacheck
license: Apache-2.0
local clone: .paxiom-runtime/upstream/keccacheck
```

## Why This Matters

Paxiom's Ethereum inclusion proof is dominated by Keccak:

- `keccak(address)` for the account trie key,
- `keccak(slot32)` for the storage trie key,
- `keccak(rlp_node)` for every account proof node,
- `keccak(rlp_node)` for every storage proof node.

Traditional Keccak circuits are expensive per instance. Keccacheck changes the economics when
many Keccak permutations are batched together.

The paper reports:

- worse economics for a single Keccak permutation,
- competitive performance at roughly `16` batched permutations,
- about `10x` improvement at `512` batched permutations,
- `1024` permutations at roughly `4.6M` constraints and `11.786s` proving time in the reported
  recursive Gnark benchmark,
- asymptotic cost approaching roughly `3456` constraints per permutation for very large batches.

## Paxiom Interpretation

This makes AO useful in a very specific way:

```text
many Ethereum inclusion witnesses
  -> collect Keccak permutation tasks
  -> batch into Keccacheck jobs
  -> prove/verify Keccacheck
  -> feed RLP/MPT path constraints with verified node hashes
  -> aggregate subscriber receipts
```

AO should schedule and dedupe Keccak batches. It should not be placed on the hot path for every
small hash. Subscriber feed publication can happen after local proof verification while AO receipt
posting and durable aggregation run in parallel.

## Current Paxiom Hook

Build a real Ethereum inclusion witness:

```sh
npm run zk:witness:inclusion -- --block=finalized
```

Estimate the Keccacheck batch shape:

```sh
npm run zk:plan:keccacheck -- --witness=.paxiom-runtime/ethereum-inclusion-witness.json
```

The planner counts:

- account/storage trie-key Keccaks,
- proof-node Keccaks,
- one Keccak-f permutation per 136-byte Keccak-256 rate block plus padding.

## Backend Work Order

1. Build a thin adapter around the upstream Rust Keccacheck prover for a batch of Keccak-f input
   and output states.
2. Add a Paxiom batch format that maps witness node byte arrays into Keccak sponge permutation
   states.
3. Verify the Keccacheck proof through the upstream Gnark recursive verifier or a Paxiom-compatible
   wrapper.
4. Bind verified Keccak outputs back into the normalized inclusion witness.
5. Add RLP constraints for account/storage branch, extension, and leaf nodes.
6. Add MPT path constraints that consume the verified node hashes.
7. Compose into `zk_state_inclusion_verified` receipts.

## Open Risks

- Keccacheck proves Keccak-f permutations, not the full Ethereum Keccak-256 sponge relation by
  itself. Paxiom must faithfully build sponge absorption, padding, and output extraction.
- Small batches are not the win. Paxiom needs block/window-level batching across many predicates.
- The paper's recursive benchmark is Gnark-focused. Paxiom must decide whether to use Gnark
  directly, wrap it, or port the verifier into another proof system.
- RLP/MPT still need their own constraints. Keccacheck removes the largest hash bottleneck; it
  does not remove trie parsing.
