# Phase 0 Substrate Gates

The public build map ([paxiom-static/paxiom-build-map.html](https://github.com/k-luecke/paxiom-static/blob/main/paxiom-build-map.html))
lists three substrate gates that block all of Phase 1. This sheet says what
"closed" looks like for each, where the evidence lives, and which command
proves the gate locally.

## A-120 / S.01 — HyperBEAM operational locally

**Acceptance:** `rebar3 shell` opens a working HyperBEAM session, `~evm@1.0`
device is executable, message dispatch through `hb_ao` returns `{ok, _}`.

**Evidence:** [`hyperbeam/bringup/`](../hyperbeam/bringup/).

**Operator proof:**

```bash
./hyperbeam/bringup/install.sh         # one-shot
./hyperbeam/bringup/smoke-test.sh       # exit 0 == gate closed
```

Status: **operator-runnable** (Phase 0 scaffolding complete; live HyperBEAM
bring-up is the operator's job — gate closes when smoke-test exits 0).

## A-120 / S.02 — Sync committee verifier wrapped as HyperBEAM device

**Acceptance:** the `~bls-sync-committee@1.0` device is registered with a
running HyperBEAM node, `POST /v1/sync-committee/verify` returns
`verified: true` for a real recent slot, and the request emits an AO
compliance message logged to Arweave.

**Evidence:**
- Harness: [`k-luecke/bls-verifier`](https://github.com/k-luecke/bls-verifier) — `bls-device/` crate, [O-702 runbook](https://github.com/k-luecke/bls-verifier/blob/master/docs/O-702-bls-device-runbook.md)
- Manifest + integration: [`hyperbeam/devices/bls-sync-committee/`](../hyperbeam/devices/bls-sync-committee/)
- Service: [`services/sync-committee/`](../services/sync-committee/)

**Fixture-only proof (CI):**

```bash
npm run test:sync-committee
# 4 tests pass — schema, x402-stub, dispatch shape, validator
```

**Live proof (operator):**

```bash
./hyperbeam/bringup/install.sh
./hyperbeam/bringup/shell.sh                                  # in terminal A
./hyperbeam/devices/bls-sync-committee/register.sh             # in terminal B
node services/sync-committee/server.mjs                        # in terminal C
curl -fsSL -X POST http://localhost:8080/v1/sync-committee/verify \
    -H 'Content-Type: application/json' \
    -d @<request-built-from-current-head.json>
# expected: verified=true
```

Status: **scaffolded** (CI proof passes; live proof requires HyperBEAM up
plus a refresh of `bls_verifier.wasm` per [`hyperbeam/devices/bls-sync-committee/UPDATE.md`](../hyperbeam/devices/bls-sync-committee/UPDATE.md)).

## A-120 / S.03 — Load Network state reconstruction tested end-to-end

**Acceptance:** state reconstruction from Load Network archive working
end-to-end for at least one historical block.

**Evidence:** [`load-network/`](../load-network/).

**Fixture-only proof (CI):**

```bash
npm run test:load-network
# 3 tests pass — block + account, block + slot, address-mismatch rejection
```

**Live proof (operator):**

```bash
LOAD_NETWORK_API_KEY=... LOAD_NETWORK_LIVE=1 npm run test:load-network
# reconstructs WETH at block 19_000_000 from real load.network
```

Status: **scaffolded** (CI proof passes against synthesised fixtures; live
proof requires a Load Network API key and one fixture refresh via
[`load-network/fixtures/record.mjs`](../load-network/fixtures/record.mjs)).

## What flips when these close

The following items move from "What's still in flight" to "What's done" in
[`paxiom-static/paxiom-build-map.html`](https://github.com/k-luecke/paxiom-static/blob/main/paxiom-build-map.html):

- HyperBEAM fully operational locally via `rebar3 shell` ← S.01
- Sync committee verifier confirmed working in current environment ← S.02
- Load Network state reconstruction integration tested end-to-end ← S.03
- Reference implementation of Service 02 (sync committee) ← S.02

The static-site PR (`paxiom-static/claude/build-hyperbeam-network-uIaMZ`)
makes those flips contingent on this PR landing first.
