# Load Network Integration

Closes Phase 0 / A-120 / S.03. After this runbook, the operator has end-to-end
state reconstruction from Load Network archive working for at least one
historical block, **with cryptographic proof verification at every step.**

## Current S.03 direction

Load/Ultraviolet remains useful reference work, but Paxiom is no longer
waiting on a public proof API to close S.03. The working path is:

1. Retrieve EIP-1186-shaped MPT witnesses from infrastructure Paxiom controls
   (Erigon/Reth on real local or VM storage first).
2. Verify the witness locally against a sync-committee-trusted Ethereum state
   root.
3. Package the verified proof material into an encrypted Paxiom proof archive
   bundle.
4. Store the bundle locally for rehearsal or on Arweave for durable testnet
   evidence; optionally index the manifest through AO. Google Drive can hold
   encrypted proof bundles after verification, but it is not an execution-node
   datadir.

The `load-network/` verifier remains valuable because it already proves the
critical property: values are accepted because the MPT proof verifies, not
because an RPC or archive service returned them.

See `docs/paxiom-proof-archive.md` for the archive writer and env contract.

## What is Load Network

[`load.network`](https://load.network) — Ethereum transaction data archived
permanently on Arweave with deterministic state reconstruction. EVM-
compatible L1; the relevant API surface for Paxiom is the EIP-1186-shaped
endpoints that return Merkle Patricia Trie proofs alongside values, so the
data can be verified locally against a state root without trusting the
service. Replaces RPC as the substrate for Paxiom's state-related services.
The "no-RPC" architectural moat described in `paxiom-build-map.html` (R-200)
lives on top of this client.

## What's in `load-network/`

```
load-network/
├── client.mjs             — HTTP client (rate-limit, backoff, structured logging)
├── erigon-client.mjs      — Local Erigon JSON-RPC adapter for EIP-1186 proofs
├── verifier.mjs           — Pure MPT proof verifier (uses @ethereumjs/trie)
├── reconstruct.mjs        — client → verify → typed envelope; no fallback
├── errors.mjs             — Network / Data / Verification / Protocol taxonomy
├── fixtures/              — Synthesised + (eventually) recorded responses
│   ├── synthesise.mjs     — Build self-consistent CI fixtures (no network)
│   └── record.mjs         — Operator-only: refresh from real load.network
└── test/
    ├── verifier.test.mjs    — 12 round-trip tests against synthesised tries
    ├── reconstruct.test.mjs — 7 fixture-driven end-to-end + failure-mode tests
    ├── erigon-client.test.mjs — local Erigon RPC shape adapter tests
    └── live.test.mjs        — gated on LOAD_NETWORK_LIVE=1
```

## What was built in this PR (the no-RPC moat, made true)

The Phase 0 scaffolding wired up the HTTP client and trusted the archive
bundle's `account_state` / `storage` fields directly. That was a short-term
shortcut — the architectural moat said the data was trustworthy because of
the proof, but no proof was actually being walked. This PR closes that gap:

- **`verifier.mjs`** — pure MPT verifier built on `@ethereumjs/trie`. Two
  high-level entry points: `verifyAccountProof` (binds an account leaf to
  a state root) and `verifyStorageProof` (binds a storage value to a
  storage root). Both throw `LoadNetworkVerificationError` with a stable
  `reason` on any failure.
- **`reconstruct.mjs`** — every value returned to a caller now passes
  through MPT verification first. Tampered proof, wrong root, missing key,
  empty proof array — each surfaces as a typed verification error. There
  is **no fallback** to a conventional RPC; failure is surfaced to the
  caller.
- **`errors.mjs`** — four-category error taxonomy (Network, Data,
  Verification, Protocol). The category drives retry posture; the
  `reason` enum on Verification errors drives metrics grouping.
- **Witness exposed for Service 01.** `reconstructStorageSlot` returns a
  `witness` object containing the MPT path (account proof + storage proof)
  in a stable shape — Service 01's ZK circuit consumes this directly as
  witness data instead of digging into the raw load.network response.

Why `@ethereumjs/trie` and not a bespoke implementation: Ethereum MPT
semantics (compact nibble encoding, three node types, RLP framing) are a
well-known cryptographic footgun. Three rolled-our-own-MPT bugs that
shipped in Phase 0 rather than one well-audited dep is the wrong
trade-off. The dep adds ~150KB to node_modules and is already a
transitive dep of the Ethereum tooling we use elsewhere.

## Step 1 — CI fixture test

```bash
npm run test:load-network
# 23 tests pass
```

The fixture is synthesised by `fixtures/synthesise.mjs`: a small but
real MPT containing one account + one storage slot, with valid proofs
against synthetic state and storage roots. Every CI assertion exercises
the actual verifier walk. Tampering tests confirm that perturbed input
surfaces as the right `LoadNetworkVerificationError`.

## Step 2 — Refresh fixtures from real load.network

Once you have an API key:

```bash
LOAD_NETWORK_API_KEY=... \
  node load-network/fixtures/record.mjs \
    --block 19000000 \
    --address 0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2 \
    --slot 0x0
```

The recorded fixture replaces the synthesised one. The verifier doesn't
care which it is — both must verify against their claimed roots — but
the recorded fixture additionally proves end-to-end interop with the
real Load Network API shape.

Pick a frozen historical block. Block 19 000 000 (~Jan 2024) is recommended:
- Pre-Cancun: not subject to reorg
- WETH is a well-known anchor address that will exist forever
- Slot 0 is a string constant ("Wrapped Ether"), unambiguous

## Step 3 — Operator live test

```bash
LOAD_NETWORK_URL=https://<provisioned-load-proof-api> \
LOAD_NETWORK_API_KEY=... \
LOAD_NETWORK_LIVE=1 \
npm run test:load-network
# pass: reconstructs WETH at block 19 000 000 from real load.network
```

Exiting 0 closes A-120 / S.03.

The live client expects a provisioned archive-proof API with these paths:

- `GET /v1/blocks/:block`
- `GET /v1/state/:block/account/:address`
- `GET /v1/state/:block/storage/:address/:slot`

The public `https://load.network` site may return `404` for those paths; that
means the proof API endpoint has not been pointed at the client yet. It is not
a verifier failure. Set `LOAD_NETWORK_URL` to the operator-provisioned Load
Network archive API before treating `LOAD_NETWORK_LIVE=1` as a gate.

## Local Erigon proof source

Services can bypass Load's HTTP shape and read EIP-1186 proofs from a local or
VM-hosted Erigon/Reth endpoint:

```bash
export PAXIOM_STATE_SOURCE=erigon
export PAXIOM_ERIGON_RPC_URL=http://127.0.0.1:8545
```

`ErigonProofClient` converts `eth_getBlockByNumber` and `eth_getProof` results
into the same internal block/account/storage shape consumed by
`reconstruct.mjs`. Paxiom still verifies the MPT proof before signing. A local
JSON-RPC response is transport, not authority.

Do not place the live Erigon MDBX datadir on Google Drive. That experiment was
retired after proving too slow and fragile for node operation. If Drive is used
at all, use it only as a cold store for encrypted, already-verified proof
archive bundles.

## Used by

- **Service 5 (A-205) — Verified Historical State.** Primary user. Every
  historical-state query is rooted in `load-network/`.
- **Service 1 (A-201) — Slot Storage Proofs.** Consumes the `witness`
  object as ZK witness data. The witness shape is the stable interface;
  Service 01 should not dig into raw load.network responses.
- **Service 3 (A-203) — Cross-Chain Message Verification.** Source-chain
  state proofs use `load-network/` reconstruction.

## Hardening follow-ups (filed)

- **Caching of trie nodes by hash.** Currently every `reconstructStorageSlot`
  call walks the proofs from scratch. An in-memory cache keyed on
  (block, node-hash) would short-circuit repeat fetches when the access
  pattern is known to overlap. Skipped for Phase 0 to keep the surface
  small; add when a real workload exposes the hot path.
- **Failover across multiple archive sources.** The pattern established
  for `~bls-sync-committee` (EWMA-ranked endpoints, 60s degrade on error)
  applies here once a second archive source is in scope.
- **Real-mainnet test vectors.** The CI tests use synthesised tries; an
  additional vector built from a real Ethereum mainnet `eth_getProof`
  response (fetched once, committed) would catch any subtle interop
  drift.
- **Period-boundary fixture refresh automation.** Whenever a fork lands
  or a new well-known anchor block is needed, refresh the fixture via
  `record.mjs` and commit. Suggest adding a CI job that fails if the
  fixture is older than 90 days.
