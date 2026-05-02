# `load-network/` — historical state reconstruction without RPC

The architectural moat: every state query Paxiom answers is rooted in
Arweave-archived Ethereum transaction data via [Load Network](https://load.network),
not in RPC-sourced witnesses. From the build map's R-200 note:

> "the proof is as trustworthy as Ethereum itself, not as trustworthy as
> your RPC provider"

This module is what makes that claim true for Service 5 (Verified Historical
State) and what eliminates the RPC dependency for Services 1 and 3.

## What's here

- `client.mjs` — HTTP client. Honors 429 + `Retry-After`; exponential
  backoff on 5xx; structured `LoadNetworkError`; pluggable `fetchImpl` so
  tests can stand in fixtures.
- `reconstruct.mjs` — `reconstructAccountState` and `reconstructStorageSlot`.
  Each returns the canonical `{block_hash, state_root, archive_root, ...}`
  envelope sourced from the archive.
- `fixtures/` — recorded archive responses for a frozen historical block
  (default: 19000000, WETH at slot 0). Refresh via `fixtures/record.mjs`
  once `LOAD_NETWORK_API_KEY` is provisioned.
- `test/reconstruct.test.mjs` — fixture-only, runs in CI.
- `test/live.test.mjs` — gated on `LOAD_NETWORK_LIVE=1`; the operator
  proof for Phase 0 / A-120 / S.03.

## Run tests

```bash
# CI / fixture-only:
npm run test:load-network

# Operator:
LOAD_NETWORK_LIVE=1 LOAD_NETWORK_API_KEY=... npm run test:load-network
```

## Refresh fixtures

```bash
LOAD_NETWORK_API_KEY=... \
  node load-network/fixtures/record.mjs \
    --block 19000000 \
    --address 0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2 \
    --slot 0x0
git diff load-network/fixtures
```

Pick a frozen historical block (one whose state will not be re-orged or
otherwise mutate). 19_000_000 is a safe pre-Cancun anchor.

## Phase 0 gate

After `npm run test:load-network` passes in CI **and** the operator runs
`LOAD_NETWORK_LIVE=1 npm run test:load-network` against real Load Network
once, A-120 / S.03 is closed. See [`../docs/phase-0-gates.md`](../docs/phase-0-gates.md).
