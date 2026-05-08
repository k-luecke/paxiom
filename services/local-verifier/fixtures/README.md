# local-verifier static MVP fixtures

> **Static MVP fixtures.** Hand-built, checked-in, deterministic. They
> contain no live blockchain data, no proof of any external state, and
> make no network claims. They exist so `fixture-proof-verifier-v0` can
> exercise the receipt chassis end-to-end without external dependencies.

## Format

Each fixture file is a JSON object:

```json
{
  "fixture_id": "fp-v0-canonical-pass",
  "fixture_kind": "canonical-json-sha256-v0",
  "description": "...",
  "payload": { ... },
  "expected_canonical_sha256": "<hex>",
  "note": "Static MVP fixture..."
}
```

`fixture-proof-verifier-v0` replays the fixture by computing
`sha256(canonical_json(payload))` and comparing to
`expected_canonical_sha256`. The recomputed decision is `pass` on match,
`fail` otherwise. The caller's `claimed_result` is then compared to the
recomputed decision.

## Available fixtures

### `fixture-proof-verifier-v0` (kind `canonical-json-sha256-v0`)

| fixture_id              | recomputed decision | purpose                            |
|-------------------------|---------------------|------------------------------------|
| `fp-v0-canonical-pass`  | `pass`              | recompute matches expected hash    |
| `fp-v0-canonical-fail`  | `fail`              | expected hash intentionally bad    |

### `ethereum-header-fixture-verifier-v0` (kind `ethereum-block-header-v0`)

| fixture_id                 | declared block_hash matches recompute? | purpose                                                  |
|----------------------------|----------------------------------------|----------------------------------------------------------|
| `eth-header-v0-good`       | yes                                    | well-formed 15-field header                              |
| `eth-header-v0-tampered`   | no (first nibble flipped)              | exercise mismatch path; verifier authority is recompute  |

### `ethereum-mpt-fixture-verifier-v0`

This verifier reads from
[`load-network/fixtures/`](../../../load-network/fixtures/), **not** from
this directory. Those fixtures are synthesised by
[`synthesise.mjs`](../../../load-network/fixtures/synthesise.mjs) and
contain real `@ethereumjs/trie` MPT proofs that chain to their declared
roots. The MPT verifier is a thin adapter over the audited walker in
[`load-network/verifier.mjs`](../../../load-network/verifier.mjs); we do
not duplicate fixture data here.

Default fixture dir for the MPT verifier can be overridden with
`PAXIOM_LOCAL_VERIFIER_MPT_FIXTURE_DIR` (used by tests).

### `sync-committee-fixture-verifier-v0` (kind `ethereum-sync-committee-update-v0`)

| fixture_id                           | declared expected.* matches recompute? | purpose                                               |
|--------------------------------------|----------------------------------------|-------------------------------------------------------|
| `sc-v0-period-1041-good`             | yes                                    | well-formed structural fixture                        |
| `sc-v0-period-1041-tampered`         | no (signing_root nibble flipped)       | exercise `sync_committee_invalid` path                |

The fixtures store a hand-built sync-committee update: 15 fields
including `slot`, `fork_version`, `genesis_validators_root`,
`block_root`, `parent_root`, `sync_aggregate.{sync_committee_bits,
sync_committee_signature}`, plus an `expected.{domain, signing_root,
participation}` block. The `signing_root` is computed at generation
time as `sha256(parent_root || domain)` where
`domain = DOMAIN_SYNC_COMMITTEE || sha256(fork_version_padded_32 ||
genesis_validators_root)[..28]` — the same SSZ derivation used in
[`bls-verifier/bls-verify-cli/src/main.rs`](../../../bls-verifier/bls-verify-cli/src/main.rs).

`sync_aggregate.sync_committee_signature` is a 96-byte zero
**placeholder**. v0 reads it but does not verify it. Real BLS
aggregate verification is `sync-committee-bls-verifier-v1`.

Regenerate via:

```bash
node services/local-verifier/fixtures/make-sync-committee.mjs
```

The fixtures store the 15 classic-format header fields as hex. The
`block_hash` is computed at generation time as
`keccak256(rlp(header))` using `@ethereumjs/rlp` plus
`ethereum-cryptography/keccak`, so the good fixture is correct by
construction.

## Regenerating

```bash
node services/local-verifier/fixtures/make.mjs                  # canonical-json fixtures
node services/local-verifier/fixtures/make-ethereum-header.mjs  # eth-header fixtures
```

Both generators and the resulting JSON are checked in.

## Not in scope here

- Live Ethereum / AO / Arweave data
- Proofs that require `@ethereumjs/trie` or signature verification
- Anything claiming to mirror real chain state

The richer Ethereum-shaped fixtures already live under
[`load-network/fixtures/`](../../../load-network/fixtures/) and will be
consumed by a future `ethereum-header-verifier-v0`, not by this one.
