# Load Network Integration

Closes Phase 0 / A-120 / S.03. After this runbook, the operator has end-to-end
state reconstruction from Load Network archive working for at least one
historical block.

## What is Load Network

[`load.network`](https://load.network) — Ethereum transaction data archived
permanently on Arweave with deterministic state reconstruction. Replaces RPC
as the substrate for Paxiom's state-related services. The "no-RPC" architectural
moat described in `paxiom-build-map.html` (R-200) lives on top of this client.

## What's in `load-network/`

```
load-network/
├── client.mjs          # HTTP client (rate limits, backoff, structured errors)
├── reconstruct.mjs     # reconstructAccountState, reconstructStorageSlot
├── fixtures/           # recorded archive responses for CI
│   ├── MANIFEST.json
│   ├── block_19000000.json
│   ├── account_19000000_weth.json
│   ├── storage_19000000_weth_slot0.json
│   └── record.mjs      # operator-only fixture refresher
├── test/
│   ├── reconstruct.test.mjs   # CI gate
│   └── live.test.mjs          # operator gate (LOAD_NETWORK_LIVE=1)
└── README.md
```

## Step 1 — CI fixture test

```bash
npm run test:load-network
# 3 tests pass
```

The fixture is currently a synthesised stand-in — file shapes that match the
real Load Network API, anchored on Ethereum mainnet block 19_000_000 (a
pre-Cancun, frozen historical block; will not be re-orged or mutated).

Replace with real captures via:

## Step 2 — Refresh fixtures from real load.network

Once you have an API key:

```bash
LOAD_NETWORK_API_KEY=... \
  node load-network/fixtures/record.mjs \
    --block 19000000 \
    --address 0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2 \
    --slot 0x0
```

Pick a frozen historical block. Block 19_000_000 (~Jan 2024) is recommended
because:
- Pre-Cancun: not subject to reorg
- WETH is a well-known anchor address that will exist forever
- Slot 0 is a string constant ("Wrapped Ether"), unambiguous

Commit the refreshed fixture; `git diff load-network/fixtures` shows what
changed.

## Step 3 — Operator live test

```bash
LOAD_NETWORK_API_KEY=... LOAD_NETWORK_LIVE=1 npm run test:load-network
# pass: reconstructs WETH at block 19_000_000 from real load.network
```

Exiting 0 closes A-120 / S.03.

## Used by

- **Service 5 (A-205) — Verified Historical State.** Primary user. Every
  historical-state query is rooted in `load-network/`.
- **Service 1 (A-201) — Slot Storage Proofs.** Optional witness source.
  Today's launch acceptable to use RPC; A-201 should switch to
  `load-network/` once it's exercised end-to-end.
- **Service 3 (A-203) — Cross-Chain Message Verification.** Source-chain
  state proofs use `load-network/` reconstruction.

## Hardening follow-ups

- **MPT proof verification.** `reconstruct.mjs` currently trusts the archive
  bundle's `account_state` / `storage` fields directly. Replacing this with
  a Merkle Patricia Trie walk against the bundle's pre-images closes the
  remaining trust assumption (load.network is honest about state-trie shape).
- **Period-boundary fixture refresh automation.** Whenever a fork lands or
  a new well-known anchor block is needed, refresh the fixture via
  `record.mjs` and commit. Suggest adding a CI job that fails if the fixture
  is older than 90 days.
- **load.network rate-limit handling under burst.** The `Retry-After` honor
  is implemented; load-test under concurrent reconstructs to confirm the
  backoff doesn't compound.
