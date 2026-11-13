# `services/sync-committee/` — Service A-202 HTTP front-end

Owns `POST /v1/sync-committee/verify` per [O-701 / S.02](https://github.com/k-luecke/bls-verifier/blob/master/docs/O-701-hyperbeam-bls-device.md).
The cryptographic work happens in the HyperBEAM `~bls-sync-committee@1.0`
device (see [`../../hyperbeam/devices/bls-sync-committee/`](../../hyperbeam/devices/bls-sync-committee/));
this service is the public face that x402-gates and dispatches.

## Run

```bash
# CI / local without HyperBEAM:
MOCK_DEVICE=1 node services/sync-committee/server.mjs

# Paid Base Sepolia rehearsal:
REQUIRE_X402=1 \
X402_MODE=testnet \
X402_PAY_TO=0xYourReceivingWallet \
BLS_DEVICE_VIA_SUBPROCESS=1 \
BLS_DEVICE_HARNESS=/absolute/path/to/bls-device-harness \
node services/sync-committee/server.mjs

# Live HyperBEAM dispatch (requires hyperbeam/bringup + register.sh):
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

`REQUIRE_X402=1` enables the official x402 resource-server middleware. The
middleware verifies payment with the hosted facilitator, runs the device only
after verification, settles the payment, and only then releases the JSON
response. Unpaid calls receive `402` with `PAYMENT-REQUIRED`.

Working prices:

| Mode | Network | Price |
|------|---------|-------|
| `X402_MODE=testnet` | Base Sepolia (`eip155:84532`) | `$0.001` |
| `X402_MODE=mainnet` | Base mainnet (`eip155:8453`) | `$0.01` |

Safety rule: `REQUIRE_X402=1` refuses to start with `MOCK_DEVICE=1`. Mock
responses are useful for local tests, but they are never billable.

Use `BLS_DEVICE_VIA_SUBPROCESS=1` for the first paid pilot because the harness
has already produced real mainnet `verified:true` evidence. Move to the
HyperBEAM-hosted device after registration is proven.

Public metadata is exposed at:

- `GET /mcp/tools.json`
- `GET /mcp/paxiom-sync-committee.json`
