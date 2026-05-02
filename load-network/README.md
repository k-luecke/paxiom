# `load-network/` — historical state reconstruction without RPC

The architectural moat: every state query Paxiom answers is rooted in
Arweave-archived Ethereum transaction data via [Load Network](https://load.network)
**and verified against the claimed state root via a Merkle Patricia Trie
proof walk before any value is returned to the caller.** From the build
map's R-200 note:

> "the proof is as trustworthy as Ethereum itself, not as trustworthy as
> your RPC provider"

This module is what makes that claim true for Service 5 (Verified Historical
State) and what eliminates the RPC dependency for Services 1 and 3.

## What's here

```
load-network/
├── client.mjs             # HTTP client (rate limit, backoff, structured logging)
├── verifier.mjs           # Pure MPT proof verifier (uses @ethereumjs/trie)
├── reconstruct.mjs        # Compose: client → verify → typed envelope
├── errors.mjs             # Network / Data / Verification / Protocol taxonomy
├── fixtures/              # Synthesised + (eventually) recorded archive responses
│   ├── MANIFEST.json
│   ├── block_19000000.json
│   ├── account_19000000_weth.json
│   ├── storage_19000000_weth_slot0.json
│   ├── synthesise.mjs     # Build self-consistent CI fixtures (no network)
│   └── record.mjs         # Operator-only: refresh from real load.network
├── test/
│   ├── verifier.test.mjs    # 12 round-trip tests against synthesised tries
│   ├── reconstruct.test.mjs # 7 fixture-driven end-to-end + failure-mode tests
│   └── live.test.mjs        # gated on LOAD_NETWORK_LIVE=1
└── README.md
```

## The no-RPC discipline (hard constraint)

`reconstruct.mjs` will **never** return a value that hasn't been MPT-verified
against the claimed state root. If load.network can't satisfy a request,
the failure is surfaced to the caller as one of the typed errors below —
there is no fallback to a conventional RPC provider anywhere in this layer.

This is the substantive architectural claim. If you find yourself wanting
to add a fallback path, that's a sheet update to the build-map R-200 note,
not a quiet code change.

## Error taxonomy

Every failure inside this layer surfaces as one of four typed errors. The
category drives downstream retry/escalation:

| Class                          | Retryable | When raised                                           |
|--------------------------------|-----------|-------------------------------------------------------|
| `LoadNetworkNetworkError`      | yes       | 5xx, 429, transport timeout, DNS failure              |
| `LoadNetworkDataError`         | no        | 4xx, identity mismatches (address ≠ requested)        |
| `LoadNetworkVerificationError` | **never** | proof failed verification; `reason` is a stable enum  |
| `LoadNetworkProtocolError`     | no        | response shape drift (missing/typed fields)           |

`VerificationError` carries a stable `reason` from `VerificationReasons`:
`PROOF_ROOT_MISMATCH`, `PROOF_INVALID`, `STORAGE_VALUE_MISMATCH`,
`ACCOUNT_VALUE_MISMATCH`, `ACCOUNT_KEY_MISSING`, `EMPTY_PROOF`. Logs and
metrics should group on `reason`, not message text.

## ZK witness shape (Service 01 consumer interface)

`reconstructStorageSlot` returns a `witness` object that Service 01's ZK
circuit consumes directly as witness data. Shape:

```js
{
  state_root:    '0x…',                 // 32-byte
  storage_root:  '0x…',                 // 32-byte (recovered from account proof)
  account_key:   '0x…',                 // keccak256(address)
  account_proof: ['0x…', '0x…', ...],   // RLP-encoded trie nodes, root → leaf
  storage_key:   '0x…',                 // keccak256(slot, padded to 32)
  storage_proof: ['0x…', '0x…', ...],
}
```

Service 01 should consume this object verbatim — do not dig into the raw
load.network response. The shape is the stable interface; the underlying
API may drift.

## Run tests

```bash
# CI / fixture-only (no network):
npm run test:load-network          # 20 tests pass

# Operator (live load.network):
LOAD_NETWORK_LIVE=1 LOAD_NETWORK_API_KEY=... npm run test:load-network
```

The CI tests use synthesised tries with valid MPT proofs against synthetic
state roots — every assertion exercises the real verifier walk, so a
regression in verification surfaces as a CI failure.

## Refresh fixtures

Two paths:

```bash
# 1. Synthesised (default; no network needed):
node load-network/fixtures/synthesise.mjs
git diff load-network/fixtures

# 2. Real load.network capture (operator-only):
LOAD_NETWORK_API_KEY=... \
  node load-network/fixtures/record.mjs \
    --block 19000000 \
    --address 0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2 \
    --slot 0x0
```

Pick a frozen historical block (one whose state will not be re-orged or
otherwise mutate). 19 000 000 is a safe pre-Cancun anchor.

## Phase 0 gate

After `npm run test:load-network` passes in CI **and** the operator runs
`LOAD_NETWORK_LIVE=1 npm run test:load-network` against real Load Network
once, A-120 / S.03 is closed. See [`../docs/phase-0-gates.md`](../docs/phase-0-gates.md).

## Filed follow-ups

- **Caching of trie nodes by hash.** Currently every `reconstructStorageSlot`
  call walks the proofs from scratch. An in-memory cache keyed on
  (block, node-hash) would short-circuit repeat fetches against the same
  block when the access pattern is known to overlap. Skipped for Phase 0
  to keep the surface small; add when a real workload exposes the hot path.
- **Failover beacon-style across multiple archive sources.** The pattern
  established for `~bls-sync-committee` (EWMA-ranked endpoints, 60s degrade
  on error) applies here once a second archive source is in scope.
- **Real-mainnet test vectors.** The CI tests use synthesised tries; an
  additional vector built from a real Ethereum mainnet eth_getProof
  response (fetched once, committed) would catch any subtle interop drift.
