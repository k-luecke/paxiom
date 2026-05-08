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

| fixture_id              | recomputed decision | purpose                            |
|-------------------------|---------------------|------------------------------------|
| `fp-v0-canonical-pass`  | `pass`              | recompute matches expected hash    |
| `fp-v0-canonical-fail`  | `fail`              | expected hash intentionally bad    |

## Regenerating

```bash
node services/local-verifier/fixtures/make.mjs
```

The generator and the resulting JSON are both checked in.

## Not in scope here

- Live Ethereum / AO / Arweave data
- Proofs that require `@ethereumjs/trie` or signature verification
- Anything claiming to mirror real chain state

The richer Ethereum-shaped fixtures already live under
[`load-network/fixtures/`](../../../load-network/fixtures/) and will be
consumed by a future `ethereum-header-verifier-v0`, not by this one.
