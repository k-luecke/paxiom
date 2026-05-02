# `services/sync-committee/` — Service A-202 HTTP front-end

Owns `POST /v1/sync-committee/verify` per [O-701 / S.02](https://github.com/k-luecke/bls-verifier/blob/master/docs/O-701-hyperbeam-bls-device.md).
The cryptographic work happens in the HyperBEAM `~bls-sync-committee@1.0`
device (see [`../../hyperbeam/devices/bls-sync-committee/`](../../hyperbeam/devices/bls-sync-committee/));
this service is the public face that x402-gates and dispatches.

## Run

```bash
# CI / local without HyperBEAM:
MOCK_DEVICE=1 node services/sync-committee/server.mjs

# Live (requires hyperbeam/bringup + register.sh):
node services/sync-committee/server.mjs
```

## Test

```bash
npm run test:sync-committee
```

The test suite forces `MOCK_DEVICE=1` so dispatch is deterministic and CI
runs without HyperBEAM.

## Modes

| Env                              | Dispatcher target                                                          |
|----------------------------------|----------------------------------------------------------------------------|
| (default)                        | HyperBEAM node at `HYPERBEAM_DISPATCH_URL` (`http://localhost:8080/hb_ao/~bls-sync-committee@1.0/verify`) |
| `BLS_DEVICE_VIA_SUBPROCESS=1`    | spawn `BLS_DEVICE_HARNESS` (default `/usr/local/bin/bls-device-harness`) and pipe the request to stdin |
| `MOCK_DEVICE=1`                  | synthesised deterministic response — for CI and bring-up smoke tests       |

## x402

`X-PAYMENT` header is forwarded; if `REQUIRE_X402=1` is set, requests
without the header receive a 402 response. The Coinbase facilitator
verification is filed for follow-up — Phase 0 ships the stub.
