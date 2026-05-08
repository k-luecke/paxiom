# Paxiom Local Verifier (MVP)

A local HTTP service that accepts a request, performs **one deterministic
verification**, writes an audit receipt, signs the response, and exposes
replay instructions. Intentionally narrow.

## What this MVP does

- Exposes a small HTTP API (`/health`, `POST /verify`, `GET /receipts/:id`,
  `GET /replay/:id`, `GET /pubkey`).
- Runs **one** verification: `demo-verifier-v0` — recomputes
  `sha256(message)` and compares to a caller-supplied `claimed_sha256`.
- Builds a receipt with deterministic canonical-JSON hashing.
- Signs the receipt hash with a locally-generated ed25519 keypair.
- Persists the signed receipt to `data/receipts/<id>.json` and appends a
  line to `data/audit.log.jsonl`.
- Provides a CLI (`scripts/replay.mjs`) that recomputes the hash and
  verifies the signature for any stored receipt.

## What this MVP does NOT claim

- Not trustless. The signing key lives on the local disk.
- Not production-ready. No auth, no payments, no rate limiting, no TLS.
- Not a blockchain verifier. `demo-verifier-v0` is labeled exactly that.
- Does not yet wire Ethereum / AO / sync-committee / fixture-proof verifiers.
  Those replace `lib/verifier.mjs` later; the receipt loop stays the same.

## Run it

```bash
npm install
npm run service:local-verifier      # starts server on http://127.0.0.1:3000
```

In another terminal:

```bash
npm run verify:demo                 # spins up server, posts a known claim, replays it
npm test --workspaces=false -- ...  # full repo suite, see root package.json
node --test services/local-verifier/test/server.test.mjs   # this slice only
```

## Example request

```bash
curl -s -X POST http://127.0.0.1:3000/verify \
  -H 'Content-Type: application/json' \
  -d '{"message":"hello","claimed_sha256":"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"}' | jq
```

## Example receipt

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
├── server.mjs              # HTTP entrypoint
├── lib/
│   ├── canonical.mjs       # sorted-key JSON
│   ├── verifier.mjs        # demo-verifier-v0
│   ├── receipt.mjs         # build/hash/sign/verify
│   ├── store.mjs           # JSONL log + receipts/ dir
│   ├── keys.mjs            # ed25519 load-or-generate
│   └── paths.mjs           # data dir resolution
├── scripts/
│   ├── replay.mjs          # CLI replay
│   └── verify-demo.mjs     # end-to-end demo
├── test/
│   └── server.test.mjs
└── data/                   # gitignored: keys, receipts, audit log
```

## Next production gates

The point of this MVP is to lock the **shape** so we can swap the verifier
without changing the surface. Future iterations replace `lib/verifier.mjs`:

1. signature verifier (ed25519 / secp256k1 over caller-supplied payload)
2. fixture-proof verifier (replays a stored proof against stored data)
3. Ethereum header / checkpoint verifier
4. sync-committee verifier (already scaffolded under `services/sync-committee/`)
5. MPT witness verifier
6. AO / HyperBEAM service-dispatched verifier
7. x402-gated paid verifier (payment surface already scaffolded under
   `services/shared/x402.mjs`)

Until then: one boring deterministic check, one signed replayable receipt.
