# Paxiom Local Verifier (MVP)

A local HTTP service that accepts a request, dispatches to a deterministic
verifier, writes an audit receipt, signs the response, and exposes replay
instructions. Intentionally narrow.

The receipt chassis is frozen:

```
request → verifier → receipt → receipt hash → signature → audit log → replay
```

Verifiers are added **beside** the registry, never on top of each other.

## Verifiers

| id                                       | version | input                                                              | reasons                                                                          |
|------------------------------------------|---------|--------------------------------------------------------------------|----------------------------------------------------------------------------------|
| `demo-verifier-v0`                       | 0.1.0   | `{ message, claimed_sha256 }`                                      | computed sha256 matches / does not match (permanent regression baseline)         |
| `signature-verifier-v0`                  | 0.1.0   | `{ payload, public_key_pem, signature, algorithm: "ed25519" }`     | `signature_valid` / `signature_invalid` / `unsupported_algorithm` / `malformed_input` |
| `fixture-proof-verifier-v0`              | 0.1.0   | `{ fixture_id, claimed_result: "pass" \| "fail" }`                 | `fixture_valid` / `fixture_mismatch` / `fixture_not_found` / `malformed_input`   |
| `ethereum-header-fixture-verifier-v0`    | 0.1.0   | `{ fixture_id, claimed_block_hash: "0x..." }`                      | `ethereum_header_valid` / `ethereum_header_mismatch` / `fixture_not_found` / `malformed_input` / `unsupported_fixture` |
| `ethereum-mpt-fixture-verifier-v0`       | 0.1.0   | account: `{ fixture_id, proof_type: "account", claimed_state_root, claimed_account_address }` <br> storage: `{ fixture_id, proof_type: "storage", claimed_storage_root, claimed_account_address, claimed_storage_slot, claimed_storage_value }` | `mpt_account_proof_valid` / `mpt_storage_proof_valid` / `mpt_proof_invalid` / `state_root_mismatch` / `fixture_not_found` / `malformed_input` / `unsupported_fixture` |

`GET /verifiers` lists what's registered. The default verifier (when the
request body omits `verifier`) is `demo-verifier-v0` — that backward-compat
default is the reason the original demo curl example still works unchanged.

## What this MVP does

- Exposes a small HTTP API: `/health`, `/healthz`, `POST /verify`,
  `GET /receipts/:id`, `GET /replay/:id`, `GET /pubkey`, `GET /verifiers`.
- Routes each `POST /verify` through the verifier registry by `verifier` id.
- Builds a receipt with deterministic canonical-JSON hashing.
- Signs the receipt hash with a locally-generated ed25519 service keypair.
- Persists the signed receipt to `data/receipts/<id>.json` and appends a
  line to `data/audit.log.jsonl`. Each receipt links to the previous one
  via `prior_receipt_hash` regardless of which verifier produced it.
- Provides a CLI (`scripts/replay.mjs`) that recomputes the hash and
  verifies the signature for any stored receipt.

## What this MVP does NOT claim

- Not trustless. The signing key lives on the local disk.
- Not production-ready. No auth, no payments, no rate limiting, no TLS.
- Not a blockchain verifier. `demo-verifier-v0` and `signature-verifier-v0`
  are labeled exactly that.
- Does not yet wire fixture-proof / Ethereum / AO / sync-committee verifiers.
  Those land **beside** the existing entries in `lib/registry.mjs`; the
  receipt/replay contract does not change.

## Run it

```bash
npm install
npm run service:local-verifier      # starts server on http://127.0.0.1:3000
```

In another terminal:

```bash
npm run verify:demo                    # demo-verifier-v0 end-to-end demo
npm run verify:signature-demo          # signature-verifier-v0 end-to-end demo
npm run verify:fixture-demo            # fixture-proof-verifier-v0 end-to-end demo
npm run verify:ethereum-header-demo    # ethereum-header-fixture-verifier-v0 end-to-end demo
npm run verify:ethereum-mpt-demo       # ethereum-mpt-fixture-verifier-v0 end-to-end demo (account + storage)
npm run replay -- <receipt_id>         # replay any stored receipt
npm run test:local-verifier            # this slice only (81 tests)
```

## Example request: demo-verifier-v0

```bash
curl -s -X POST http://127.0.0.1:3000/verify \
  -H 'Content-Type: application/json' \
  -d '{"verifier":"demo-verifier-v0","message":"hello","claimed_sha256":"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"}' | jq
```

(Omitting `"verifier"` defaults to `demo-verifier-v0` for backward
compatibility.)

## Example request: signature-verifier-v0

```bash
curl -s -X POST http://127.0.0.1:3000/verify \
  -H 'Content-Type: application/json' \
  -d '{
    "verifier": "signature-verifier-v0",
    "payload": { "message": "hello" },
    "public_key_pem": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n",
    "signature": "<base64 ed25519 signature over canonical-JSON of payload>",
    "algorithm": "ed25519"
  }' | jq
```

The signature must be over the **canonical-JSON** encoding of `payload`
(sorted keys, no whitespace) — see `lib/canonical.mjs`. The
`scripts/verify-signature-demo.mjs` script shows the full flow.

## Example request: fixture-proof-verifier-v0

```bash
curl -s -X POST http://127.0.0.1:3000/verify \
  -H 'Content-Type: application/json' \
  -d '{"verifier":"fixture-proof-verifier-v0","fixture_id":"fp-v0-canonical-pass","claimed_result":"pass"}' | jq
```

The verifier loads `services/local-verifier/fixtures/<fixture_id>.json`,
recomputes the deterministic check declared by the fixture's
`fixture_kind`, and compares the recomputed decision (`pass` / `fail`)
to the caller's `claimed_result`.

This is **deterministic fixture verification only**. No live network is
contacted, no Ethereum / AO / Arweave state is read, and no claim is
made about chain state. The fixtures are static MVP fixtures, hand-built
and checked in under
[`services/local-verifier/fixtures/`](fixtures/).

## Example request: ethereum-header-fixture-verifier-v0

```bash
curl -s -X POST http://127.0.0.1:3000/verify \
  -H 'Content-Type: application/json' \
  -d '{
    "verifier": "ethereum-header-fixture-verifier-v0",
    "fixture_id": "eth-header-v0-good",
    "claimed_block_hash": "0x2c5a7c25957c9dea91049689b2bc8ab0beec223c957e353c3b06cc847c2a7930"
  }' | jq
```

The verifier loads the fixture, RLP-encodes the 15-field classic
Ethereum header in canonical order, computes
`keccak256(rlp(header))`, and compares to `claimed_block_hash`. The
fixture's own declared `block_hash` is also surfaced under
`details.fixture_consistent` so a tampered fixture is visible without
becoming the verifier's authority.

**No live network or RPC.** Header bytes are read from disk only.

**No MPT / account / storage proof claim.** This verifier proves only
that the encoded header hashes to the declared block hash. Account
state, storage state, finality, sync committee membership, and MPT
witnesses are out of scope and land in subsequent verifiers.

## Example request: ethereum-mpt-fixture-verifier-v0

Account proof (verifies an account exists in the world state trie at a
given state root):

```bash
curl -s -X POST http://127.0.0.1:3000/verify \
  -H 'Content-Type: application/json' \
  -d '{
    "verifier": "ethereum-mpt-fixture-verifier-v0",
    "fixture_id": "account_19000000_weth",
    "proof_type": "account",
    "claimed_state_root": "0xa01a5439dde00ff901bc2ad7ad96599edf9a149bc9996449db7bdaf12b0bd27e",
    "claimed_account_address": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"
  }' | jq
```

Storage proof (verifies a storage slot value exists in an account's
storage trie at a given storage root):

```bash
curl -s -X POST http://127.0.0.1:3000/verify \
  -H 'Content-Type: application/json' \
  -d '{
    "verifier": "ethereum-mpt-fixture-verifier-v0",
    "fixture_id": "storage_19000000_weth_slot0",
    "proof_type": "storage",
    "claimed_storage_root": "0x266cfb6bf4138f0ccfe8f389194a7eff814ff0128a28da9ee2cbcd3e05d5da40",
    "claimed_account_address": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    "claimed_storage_slot": "0x0",
    "claimed_storage_value": "0x577261707065642045746865720000000000000000000000000000000000001a"
  }' | jq
```

The verifier is a thin adapter over the audited proof walker in
[`load-network/verifier.mjs`](../../load-network/verifier.mjs). It does
**not** reimplement trie semantics — those are notoriously easy to get
wrong (compact nibble encoding, branch vs extension vs leaf, RLP
framing). The walker is the same code path Service 01's ZK witness
builder consumes, and the MPT proofs in the
[`load-network/fixtures/`](../../load-network/fixtures/) directory are
synthesised by [`synthesise.mjs`](../../load-network/fixtures/synthesise.mjs)
to be valid against their declared state and storage roots.

**Fixture-only MPT verification.** Proof bytes are read from disk only.

**No live canonical Ethereum state.** This verifier does not yet prove
that the state root is the canonical Ethereum state root for the claimed
block, that the block is part of the canonical chain, or that finality
has been reached. Those land in subsequent verifiers
(`sync-committee-fixture-verifier-v0` for finality / committee
membership, then `live-witness-retrieval-v0` once the no-RPC moat is
ready to selectively breach).

## Example receipt: demo-verifier-v0

```json
{
  "receipt_id": "f0b3...-uuid",
  "timestamp": "2026-05-08T12:34:56.000Z",
  "service_name": "paxiom-local-verifier",
  "verifier_name": "demo-verifier-v0",
  "verifier_version": "0.1.0",
  "input_hash": "3338be69...",
  "output_hash": "e85a0f47...",
  "decision": "pass",
  "reason": "computed sha256 of message matches claimed_sha256",
  "replay_command": "node services/local-verifier/scripts/replay.mjs f0b3...",
  "prior_receipt_hash": null,
  "receipt_hash": "0x9c3a...",
  "service_signature": {
    "algorithm": "ed25519",
    "key_id": "paxiom-local-verifier-dev",
    "public_key_pem": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n",
    "signature": "base64..."
  }
}
```

## Example receipt: signature-verifier-v0

```json
{
  "receipt_id": "c289...-uuid",
  "timestamp": "2026-05-08T01:54:43.798Z",
  "service_name": "paxiom-local-verifier",
  "verifier_name": "signature-verifier-v0",
  "verifier_version": "0.1.0",
  "input_hash": "3261a547...",
  "output_hash": "908b3f00...",
  "decision": "pass",
  "reason": "signature_valid",
  "replay_command": "node services/local-verifier/scripts/replay.mjs c289...",
  "prior_receipt_hash": "0x617a49ce...",
  "receipt_hash": "0x356b19d2...",
  "service_signature": { "algorithm": "ed25519", "key_id": "...", "public_key_pem": "...", "signature": "..." }
}
```

Same fields, same canonical hashing, same replay path. The only thing
that changed is `verifier_name` and the `reason` vocabulary.

## Example receipt: ethereum-header-fixture-verifier-v0

```json
{
  "receipt_id": "922d6757-...",
  "timestamp": "2026-05-08T...",
  "service_name": "paxiom-local-verifier",
  "verifier_name": "ethereum-header-fixture-verifier-v0",
  "verifier_version": "0.1.0",
  "input_hash": "...",
  "output_hash": "...",
  "decision": "pass",
  "reason": "ethereum_header_valid",
  "replay_command": "node services/local-verifier/scripts/replay.mjs 922d6757-...",
  "prior_receipt_hash": "0x...",
  "receipt_hash": "0x...",
  "service_signature": { "algorithm": "ed25519", "key_id": "...", "public_key_pem": "...", "signature": "..." }
}
```

`details` block alongside the receipt:

```json
{
  "fixture_id": "eth-header-v0-good",
  "fixture_kind": "ethereum-block-header-v0",
  "fixture_block_hash": "0x2c5a7c25...",
  "recomputed_block_hash": "0x2c5a7c25...",
  "claimed_block_hash": "0x2c5a7c25...",
  "fixture_consistent": true
}
```

## Example receipt: ethereum-mpt-fixture-verifier-v0 (account proof)

```json
{
  "receipt_id": "2583f4c2-...",
  "timestamp": "2026-05-08T...",
  "service_name": "paxiom-local-verifier",
  "verifier_name": "ethereum-mpt-fixture-verifier-v0",
  "verifier_version": "0.1.0",
  "input_hash": "...",
  "output_hash": "...",
  "decision": "pass",
  "reason": "mpt_account_proof_valid",
  "replay_command": "node services/local-verifier/scripts/replay.mjs 2583f4c2-...",
  "prior_receipt_hash": "0x...",
  "receipt_hash": "0x...",
  "service_signature": { "algorithm": "ed25519", "key_id": "...", "public_key_pem": "...", "signature": "..." }
}
```

`details` block:

```json
{
  "proof_type": "account",
  "fixture_id": "account_19000000_weth",
  "claimed_state_root": "0xa01a5439...",
  "claimed_account_address": "0xc02aaa39...",
  "fixture_address": "0xc02aaa39...",
  "fixture_storage_root": "0x266cfb6b...",
  "proof_node_count": 1
}
```

## Example receipt: fixture-proof-verifier-v0

```json
{
  "receipt_id": "1dcd9d74-...",
  "timestamp": "2026-05-08T...",
  "service_name": "paxiom-local-verifier",
  "verifier_name": "fixture-proof-verifier-v0",
  "verifier_version": "0.1.0",
  "input_hash": "...",
  "output_hash": "304eb6d7...",
  "decision": "pass",
  "reason": "fixture_valid",
  "replay_command": "node services/local-verifier/scripts/replay.mjs 1dcd9d74-...",
  "prior_receipt_hash": "0x...",
  "receipt_hash": "0x304eb6d7...",
  "service_signature": { "algorithm": "ed25519", "key_id": "...", "public_key_pem": "...", "signature": "..." }
}
```

The receipt response also includes a `details` block alongside the
receipt, with the recomputed evidence:

```json
{
  "fixture_id": "fp-v0-canonical-pass",
  "fixture_kind": "canonical-json-sha256-v0",
  "fixture_content_sha256": "e716f854...",
  "recomputed_decision": "pass",
  "claimed_result": "pass",
  "recomputed": {
    "recomputed_canonical_sha256": "c29b222b...",
    "expected_canonical_sha256": "c29b222b...",
    "matches": true
  }
}
```

## Replay

Two ways to replay a receipt:

```bash
# CLI: recomputes canonical hash and verifies signature against embedded pubkey.
node services/local-verifier/scripts/replay.mjs <receipt_id>

# HTTP: same check, served from the running service.
curl http://127.0.0.1:3000/replay/<receipt_id>
```

`receipt_hash` is computed over every receipt field except `receipt_hash`
and `service_signature` itself, using sorted-key canonical JSON. So anyone
holding the receipt and the public key can independently confirm it.

## File layout

```
services/local-verifier/
├── server.mjs                      # HTTP entrypoint, dispatches via registry
├── lib/
│   ├── canonical.mjs               # sorted-key JSON
│   ├── verifier.mjs                # demo-verifier-v0 (frozen baseline)
│   ├── verifiers/
│   │   ├── signature.mjs           # signature-verifier-v0
│   │   ├── fixture-proof.mjs       # fixture-proof-verifier-v0
│   │   ├── ethereum-header.mjs     # ethereum-header-fixture-verifier-v0
│   │   └── ethereum-mpt.mjs        # ethereum-mpt-fixture-verifier-v0 (thin adapter over load-network/verifier.mjs)
│   ├── registry.mjs                # verifier dispatch
│   ├── receipt.mjs                 # build/hash/sign/verify
│   ├── store.mjs                   # JSONL log + receipts/ dir
│   ├── keys.mjs                    # ed25519 load-or-generate
│   └── paths.mjs                   # data dir resolution
├── fixtures/                              # static MVP fixtures (checked in)
│   ├── README.md
│   ├── make.mjs                           # regenerator (canonical-json fixtures)
│   ├── make-ethereum-header.mjs           # regenerator (eth-header fixtures)
│   ├── fp-v0-canonical-pass.json
│   ├── fp-v0-canonical-fail.json
│   ├── eth-header-v0-good.json
│   └── eth-header-v0-tampered.json
├── scripts/
│   ├── replay.mjs                         # CLI replay
│   ├── verify-demo.mjs                    # demo-verifier-v0 end-to-end
│   ├── verify-signature-demo.mjs          # signature-verifier-v0 end-to-end
│   ├── verify-fixture-demo.mjs            # fixture-proof-verifier-v0 end-to-end
│   ├── verify-ethereum-header-demo.mjs    # ethereum-header verifier end-to-end
│   └── verify-ethereum-mpt-demo.mjs       # ethereum-mpt verifier end-to-end (account + storage)
├── test/
│   ├── server.test.mjs                    # 13 demo + chassis tests
│   ├── signature.test.mjs                 # 11 registry + signature tests
│   ├── fixture.test.mjs                   # 16 fixture + cross-verifier regression tests
│   ├── ethereum-header.test.mjs           # 19 eth-header + cross-verifier regression tests
│   └── ethereum-mpt.test.mjs              # 22 mpt + cross-verifier regression tests
└── data/                                  # gitignored: keys, receipts, audit log
```

## Next production gates

The chassis is now proven to host more than one verifier. The next
verifier lands in `lib/verifiers/`, gets registered in `lib/registry.mjs`,
and the receipt/replay contract stays untouched.

Progression (each is additive, none replaces what came before):

1. ~~`demo-verifier-v0`~~ — done. **Permanent regression baseline.** Do not mutate.
2. ~~`signature-verifier-v0`~~ — done. ed25519 today; secp256k1 / multi-alg later.
3. ~~`fixture-proof-verifier-v0`~~ — done. Replays static MVP fixtures
   (`canonical-json-sha256-v0`). No network.
4. ~~`ethereum-header-fixture-verifier-v0`~~ — done. Replays a 15-field
   Ethereum-spec header; `keccak256(rlp(header))`. No live RPC.
   Header-only.
5. ~~`ethereum-mpt-fixture-verifier-v0`~~ — done. Replays Ethereum
   account / storage proofs against a caller-supplied root using the
   audited walker in [`load-network/verifier.mjs`](../../load-network/verifier.mjs).
   First verifier that exercises Ethereum **state evidence**.
6. **Next: `sync-committee-fixture-verifier-v0`** — wraps the existing
   [`services/sync-committee/`](../sync-committee/) scaffold (BLS
   aggregate verification + sync-committee period math) against a
   stored sync-committee update fixture. This is the verifier that
   begins to assert **canonicality**: a header is on the chain Ethereum
   recognises, not just a header that hashes correctly.
7. `live-witness-retrieval-v0` — first verifier permitted to fetch
   from a live source. By the time we get here the chassis has proved
   it can host header / MPT / sync-committee verification offline,
   and the live retrieval is the smallest possible breach of the
   no-network moat.
8. `service-dispatched-verifier-v0` — AO / HyperBEAM dispatch.
9. `paid-verifier-v0` — x402 / payment-gated wrapper around any of the above.

Building the courtroom before calling the first witness: every verifier
through `sync-committee-fixture-verifier-v0` is fixture-driven and
deterministic. Live network access only enters the chassis after the
fixture-shaped equivalents prove the contract holds.

The discipline: never change the chassis unless a verifier physically
forces it.
