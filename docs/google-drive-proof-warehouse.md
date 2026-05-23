# Google Drive Proof Warehouse

This is the cheap-first cold-storage plan for historical-state proof work.
Google Drive is allowed to be slow. It is not allowed to become trusted, and it
is no longer an active candidate for a live Erigon/Reth datadir.

## Retired Path

Running Erigon's live MDBX database directly on Google Drive was tested and
retired. The filesystem and sync behavior made node operation too slow and
fragile. Do not restart that path.

The surviving Drive role is narrower: store encrypted proof bundles, manifests,
indexes, and offline snapshots after Paxiom has already verified the underlying
MPT witness.

## Product Posture

The early product can sell slow historical-state answers. A request for a
historical price or state value can take minutes if the response is honest:

- request accepted
- proof job queued
- state witness retrieved or hydrated
- MPT proof verified locally
- encrypted proof bundle written to the warehouse
- signed response made available

That is a product scope decision, not a correctness compromise.

## Drive Role

Use Google Drive as a cold warehouse for encrypted objects:

- `.paxiom-proof.json` encrypted proof bundles
- offline Erigon/Reth snapshots or checkpoint exports
- selected `eth_getProof` witness packets after verification
- manifest indexes and checksums

Do not treat Google Drive as the authority. Do not store signing keys,
Arweave wallet keys, or proof-archive encryption keys there.

## Erigon/MDBX Risk Boundary

Running Erigon's live MDBX database directly on a Drive mount is retired. If
Drive, rclone, or the filesystem layer behaves strangely while storing archived
objects, that should cause a job failure or rehydration, not a false customer
claim.

The guardrail is simple: Paxiom does not sign the Erigon result. Paxiom signs
only after:

1. the witness is retrieved,
2. the MPT proof verifies against an Ethereum state root,
3. the proof bundle is encrypted,
4. the archive bundle hash and manifest hash are recorded.

Corruption can make a job slow or unavailable. It should not make an invalid
state value verify.

## Recommended Layout

```text
Google Drive/PaxiomWarehouse/
  proof-archive/
    <manifestHash>.paxiom-proof.json
  erigon-snapshots/       offline exports only; not a live datadir
  work-requests/
  indexes/

Local disk:
  .paxiom/workbench/
  .paxiom/proof-archive-hot/
  .paxiom/consensus-hot/
```

For the first deployment, point `PAXIOM_PROOF_ARCHIVE_DIR` at the local
Google Drive sync directory or an rclone mount. Keep the mode `local` so Paxiom
knows this is an operator warehouse write, not a direct Arweave claim.

```bash
export PAXIOM_PROOF_ARCHIVE_MODE=local
export PAXIOM_PROOF_ARCHIVE_DIR="$HOME/Google Drive/PaxiomWarehouse/proof-archive"
export PAXIOM_PROOF_ARCHIVE_WAREHOUSE=google-drive
export PAXIOM_PROOF_ARCHIVE_STORAGE_CLASS=cold-warehouse
export PAXIOM_PROOF_ARCHIVE_LATENCY_CLASS=async-minutes
export PAXIOM_PROOF_ARCHIVE_ENCRYPTION_KEY_BASE64="$(openssl rand -base64 32)"
export PAXIOM_PROOF_ARCHIVE_KEY_ID=paxiom-proof-archive-key-001
```

Run integrity checks after sync:

```bash
npm run proof-archive:verify -- "$PAXIOM_PROOF_ARCHIVE_DIR"
```

## Async Service Shape

Cold archive queries should graduate to an async flow. Any live proof source
should run on proper local or VM storage; Drive is only the post-verification
bundle warehouse:

```text
POST /v1/historical-state/jobs
  -> 202 Accepted
  -> x402 receipt
  -> job id
  -> estimated_seconds

GET /v1/historical-state/jobs/:id
  -> pending | verified | failed
  -> signed envelope when ready
```

The synchronous A-205 endpoint can remain for hot-cache cases. Cold Drive or
Erigon hydration should not block an HTTP request indefinitely.

## 150 GB Local Hot Tier

Reserve local disk for the data that improves freshness and correctness checks:

```text
~150 GB local reservation
  consensus-hot/        finalized headers, sync committee periods, checkpoints
  proof-archive-hot/    recent verified bundles and active customer jobs
  workbench/            one hydrated cold request at a time
```

This tier is not trying to hold all historical execution state. It gives live
services a fast path for recent requests and a local trust-anchor cache for old
requests. Older historical state jobs can still take longer:

```text
recent request
  -> local consensus/checkpoint cache
  -> local/hot proof bundle if present
  -> synchronous signed response

old request
  -> async job
  -> hydrate needed archived material from Google Drive warehouse
  -> verify locally against cached/fetched Ethereum roots
  -> encrypted bundle back to Drive/Arweave
  -> signed response when ready
```

The customer-facing product can expose this honestly as two latency classes:

- `hot-cache`: expected seconds
- `cold-warehouse`: expected minutes

Both paths still use the same correctness rule: Paxiom signs only verified
proofs, not raw RPC or raw database reads.

## What Counts as Success

The Google Drive warehouse path is acceptable when:

- bundles are encrypted before upload,
- `proof-archive:verify` passes after sync,
- no plaintext witness arrays appear in warehouse files,
- strict deployment refuses A-201/A-205 without proof archive config,
- customer-facing envelopes say `warehouse:"google-drive"` and
  `latencyClass:"async-minutes"` when that is the backing path,
- invalid or missing data results in `verified:false` or job failure, never a
  signed false state claim.
