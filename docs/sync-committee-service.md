# Sync Committee Service (A-202)

Operator runbook for `services/sync-committee/`, the HTTP front-end that
owns `POST /v1/sync-committee/verify`. The cryptographic device lives in
[`k-luecke/bls-verifier`](https://github.com/k-luecke/bls-verifier)'s
`bls-device/` crate; this service is its public face.

## Request / response

Verbatim O-701 / S.02. Validated by [`schema.mjs::validateRequest`](../services/sync-committee/schema.mjs).

Request:

```json
{
  "slot": "8421337",
  "block_root": "0x...",
  "parent_root": "0x...",
  "sync_aggregate": {
    "sync_committee_bits": "0x...",
    "sync_committee_signature": "0x..."
  }
}
```

Response:

```json
{
  "verified": true,
  "service": "A-202",
  "slot": "8421337",
  "fork_version": "0x06000000",
  "domain": "0x07000000...",
  "signing_root": "0x...",
  "participating": 437,
  "committee_size": 512,
  "primitive_return_code": 1,
  "platform_signature": "0x...",
  "ao_message_id": "..."
}
```

## Modes

Pick a dispatcher per environment:

| Env                              | Dispatcher                                                                                       |
|----------------------------------|--------------------------------------------------------------------------------------------------|
| (default)                        | HyperBEAM at `HYPERBEAM_DISPATCH_URL` (`http://localhost:8080/hb_ao/~bls-sync-committee@1.0/verify`) |
| `BLS_DEVICE_VIA_SUBPROCESS=1`    | spawn `BLS_DEVICE_HARNESS` (default `/usr/local/bin/bls-device-harness`) and pipe JSON over stdin |
| `MOCK_DEVICE=1`                  | synthesised deterministic response — for CI and bring-up smoke tests                             |

## x402 gating

`X-PAYMENT` header is forwarded to the dispatcher. If `REQUIRE_X402=1`, requests
without the header receive a 402.

The Coinbase facilitator integration is filed as a follow-up. Phase 0
ships a stub; the device's `MockX402` and the service's optional 402
gate together exercise the wire shape end-to-end.

## AO compliance hook

The HyperBEAM device emits the AO compliance message per O-701 / S.07; the
service does not double-write. The service does set
`X-PAYMENT-RESPONSE-CORRELATION` to the device's `ao_message_id` so the
caller has a handle on the audit-trail entry.

The existing `compliance.lua` AO process accepts arbitrary `EventType`s —
the device writes events of type `"SyncCommitteeVerify"` (the
`ComplianceEvent` shape in `bls-device/src/ao.rs`).

## Run

```bash
# CI / local without HyperBEAM:
MOCK_DEVICE=1 node services/sync-committee/server.mjs

# Subprocess (HyperBEAM not running, but bls-device-harness is built):
BLS_DEVICE_VIA_SUBPROCESS=1 \
  BLS_DEVICE_HARNESS=$(realpath ../bls-verifier/target/release/bls-device-harness) \
  node services/sync-committee/server.mjs

# Live (HyperBEAM running, device registered):
node services/sync-committee/server.mjs
```

## Test

```bash
npm run test:sync-committee
# 4 tests pass — healthz, schema-shape, malformed-rejection, method-rejection
```

The test suite forces `MOCK_DEVICE=1` so it runs in CI without HyperBEAM.

## Phase 0 gate

Closes A-120 / S.02 once the operator runs:

```bash
./hyperbeam/bringup/install.sh
./hyperbeam/bringup/shell.sh                       # terminal A
./hyperbeam/devices/bls-sync-committee/register.sh  # terminal B
node services/sync-committee/server.mjs             # terminal C
# Build a request from current head, POST to /v1/sync-committee/verify
# Expected: verified=true
```
