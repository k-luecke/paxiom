# Phase 1 Service Catalog

This runbook maps the public service schedule on `paxiom.org/services.html` to
local reference endpoints. Every product-facing endpoint uses the shared x402
gate, returns a signed platform envelope, and includes AO/Arweave audit-record
metadata.

## Public services

| Service | Script | Default URL | Endpoint | Reference status |
| --- | --- | --- | --- | --- |
| A-201 Slot Storage Proofs | `npm run service:slot-storage-proof` | `http://127.0.0.1:8091` | `POST /v1/slot-storage-proofs` | MPT witness packet from verified Load Network fixtures; ZK proof generation still pending |
| A-202 Sync Committee Verification | `npm run service:sync-committee` | `http://127.0.0.1:8080` | `POST /v1/sync-committee/verify` | Existing device/harness dispatch wrapped in signed service envelope |
| A-203 Cross-Chain Message Verification | `npm run service:cross-chain-message` | `http://127.0.0.1:8093` | `POST /v1/cross-chain-messages/verify` | Evidence packet accepted; bridge-grade proof verification still pending |
| A-204 Simulation as a Service | `npm run service:simulation` | `http://127.0.0.1:8094` | `POST /v1/simulations` | Deterministic reference receipt; live EVM/TEE integration still pending |
| A-205 Verified Historical State | `npm run service:historical-state` | `http://127.0.0.1:8095` | `POST /v1/historical-state/query` | Verified account/storage reconstruction from Load Network fixtures |

The internal `R-200` Load Network and `ARB-001` arb evaluator services remain
operator/substrate tooling. They are not Phase 1 products.

Machine-readable service metadata is available from:

```bash
npm run service:catalog
curl http://127.0.0.1:8090/.well-known/paxiom-services.json
```

The local product console provides catalog navigation, service health probing,
request previews, and MetaMask signature login:

```bash
npm run service:ui
open http://127.0.0.1:3000
```

To run the local Phase 1 stack behind the console in one terminal:

```bash
scripts/run-phase1-stack.sh
```

This starts the catalog, product services, support services, and UI with
localhost binds. Logs go to `log/phase1-stack/`. The UI health probes honor the
same `*_HOST` / `*_PORT` environment variables as the service entrypoints, so
non-default local ports are reflected in `/api/services/health`.

## x402 pricing

Draft prices match the public schedule:

| Service | Draft price |
| --- | ---: |
| A-201 | `$1.00 / proof` |
| A-202 | `$0.50 / verification` |
| A-203 | `$3.00 / attestation` |
| A-204 | `$0.05 / simulation` |
| A-205 | `$2.00 / query` |

Set `REQUIRE_X402=1` to require payment headers. A request without
`PAYMENT-SIGNATURE` or `X-PAYMENT` receives `402` with `PAYMENT-REQUIRED`.
Successful protected calls return `PAYMENT-RESPONSE`,
`X-PAYMENT-RESPONSE`, and `X-PAYMENT-RESPONSE-CORRELATION`.

If `X402_FACILITATOR_URL` is set, verification is delegated to
`<url>/verify`. Otherwise local header acceptance is disabled unless
`PAXIOM_ALLOW_LOCAL_X402=1` is explicitly set for local development. In
`PAXIOM_DEPLOYMENT_MODE=testnet|staging|production`, missing facilitator
configuration fails closed.

When `REQUIRE_X402=0`, endpoints may still serve private testnet proofs, but
the response payment metadata is intentionally `verified:false` and
`settled:false`.

## Response envelope

Every product endpoint returns:

- `service` and `serviceName`
- `artifact.type` and `artifact.payload`
- `auditRecord` targeting AO/Arweave
- `payment` metadata when x402 is enabled
- `platformSignature` with a response hash

If `PAXIOM_RESPONSE_SIGNING_PRIVATE_KEY_PEM` is set, signatures use Ed25519.
Without it, local development returns a deterministic `dev-sha256` signature.
In `PAXIOM_DEPLOYMENT_MODE=testnet|staging|production`, Ed25519 response
signing is mandatory and startup fails without both
`PAXIOM_RESPONSE_SIGNING_PRIVATE_KEY_PEM` and
`PAXIOM_RESPONSE_SIGNING_KEY_ID`.

## Deployment preflight

Systemd services run `services/shared/preflight.mjs` before the service
entrypoint. Strict deployment modes refuse:

- mock flags such as `MOCK_DEVICE=1`, `MOCK_LOAD_NETWORK=1`, or
  `PAXIOM_ALLOW_MOCK=1`
- missing response-signing key material
- x402 protected mode without a facilitator URL and non-zero settlement
  address
- A-203/A-204 reference services unless
  `PAXIOM_ALLOW_REFERENCE_SERVICES=1` is intentionally set

## Compliance and operator tooling

`COMPLIANCE-001` remains a separate support service for institutional evidence
capture and reporting:

```bash
npm run service:compliance
```

The compliance profile targets the CFTC GMAC Digital Asset Markets
Subcommittee and the GDF / ISDA U.S. tokenized money market fund workstream.

## Tests

```bash
npm test
npm run test:services
npm run test:ui
```

The service tests exercise the five public Phase 1 surfaces, x402 pricing,
signed envelopes, fixture-backed state reconstruction, reference simulation,
cross-chain message evidence packets, and compliance reporting. The UI tests
cover catalog exposure plus the wallet nonce and signature verification flow.
