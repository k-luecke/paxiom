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

| id                       | version | input                                                              | reasons                                                                          |
|--------------------------|---------|--------------------------------------------------------------------|----------------------------------------------------------------------------------|
| `demo-verifier-v0`       | 0.1.0   | `{ message, claimed_sha256 }`                                      | computed sha256 matches / does not match (permanent regression baseline)         |
| `signature-verifier-v0`  | 0.1.0   | `{ payload, public_key_pem, signature, algorithm: "ed25519" }`     | `signature_valid` / `signature_invalid` / `unsupported_algorithm` / `malformed_input` |

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
npm run verify:demo                 # demo-verifier-v0 end-to-end demo
npm run verify:signature-demo       # signature-verifier-v0 end-to-end demo
npm run replay -- <receipt_id>      # replay any stored receipt
npm run test:local-verifier         # this slice only (24 tests)
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
├── server.mjs                    # HTTP entrypoint, dispatches via registry
├── lib/
│   ├── canonical.mjs             # sorted-key JSON
│   ├── verifier.mjs              # demo-verifier-v0 (frozen baseline)
│   ├── verifiers/
│   │   └── signature.mjs         # signature-verifier-v0
│   ├── registry.mjs              # verifier dispatch
│   ├── receipt.mjs               # build/hash/sign/verify
│   ├── store.mjs                 # JSONL log + receipts/ dir
│   ├── keys.mjs                  # ed25519 load-or-generate
│   └── paths.mjs                 # data dir resolution
├── scripts/
│   ├── replay.mjs                # CLI replay
│   ├── verify-demo.mjs           # demo-verifier-v0 end-to-end
│   └── verify-signature-demo.mjs # signature-verifier-v0 end-to-end
├── test/
│   ├── server.test.mjs           # 13 demo + chassis tests
│   └── signature.test.mjs        # 11 registry + signature tests
└── data/                         # gitignored: keys, receipts, audit log
```

## Next production gates

The chassis is now proven to host more than one verifier. The next
verifier lands in `lib/verifiers/`, gets registered in `lib/registry.mjs`,
and the receipt/replay contract stays untouched.

Progression (each is additive, none replaces what came before):

1. ~~`demo-verifier-v0`~~ — done. **Permanent regression baseline.** Do not mutate.
2. ~~`signature-verifier-v0`~~ — done. ed25519 today; secp256k1 / multi-alg later.
3. **Next: `fixture-proof-verifier-v0`** — replay a stored proof fixture
   against stored data from this repo (e.g. `load-network/fixtures/`),
   no network, fully deterministic.
4. `ethereum-header-verifier-v0` — known header / checkpoint fixture.
5. `sync-committee-verifier-v0` — wraps existing `services/sync-committee/` scaffold.
6. `mpt-witness-verifier-v0` — attacks the harder S.03 gate.
7. `service-dispatched-verifier-v0` — AO / HyperBEAM dispatch.
8. `paid-verifier-v0` — x402 / payment-gated wrapper around any of the above.

The discipline: never change the chassis unless a verifier physically
forces it.
