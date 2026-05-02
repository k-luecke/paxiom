# `~bls-sync-committee@1.0`

The HyperBEAM device for Paxiom Service A-202 (Ethereum sync committee
verification). The cryptographic primitive lives in
[`k-luecke/bls-verifier`](https://github.com/k-luecke/bls-verifier); the
device-level pipeline (beacon failover, period-keyed cache, signing-root
computation, AO compliance hook, x402 gating) lives in that repo's
`bls-device/` crate. This directory only owns the **integration seam**:

- `manifest.json` — what HyperBEAM reads to register the device
- `bls_verifier.wasm` — vendored from `bls-verifier` (refresh per `UPDATE.md`)
- `bls_verifier.wasm.sha256` — keeps the wasm honest; the CI hash check
  fails if these drift apart
- `harness/dispatch.lua` — Lua glue that HyperBEAM invokes per incoming
  message; calls into the Rust harness binary
- `register.sh` — operator script to POST the manifest to a running
  HyperBEAM node's local registry
- `UPDATE.md` — how to refresh the vendored wasm

Smoke-test (after running `register.sh` and starting `services/sync-committee`):

```bash
curl -fsSL -X POST http://localhost:8080/v1/sync-committee/verify \
    -H 'Content-Type: application/json' \
    -d @<(cat <<EOF
{
  "slot": "8421337",
  "block_root": "0x…",
  "parent_root": "0x…",
  "sync_aggregate": {
    "sync_committee_bits": "0x…",
    "sync_committee_signature": "0x…"
  }
}
EOF
)
```

Expected: `verified: true` for any real recent slot. This is the operator
proof of the **A-120 / S.02** gate.
