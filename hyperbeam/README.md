# `hyperbeam/` — local bring-up + device manifests

This directory does **not** contain HyperBEAM itself. HyperBEAM lives upstream
at <https://github.com/permaweb/HyperBEAM> and is cloned to a sibling directory
by `bringup/install.sh`. What lives here:

- `bringup/` — operator scripts that close the **A-120 / S.01 gate** (HyperBEAM
  operational locally via `rebar3 shell`, `~evm@1.0` device executable,
  message dispatch through `hb_ao` confirmed).
- `devices/bls-sync-committee/` — the manifest, vendored wasm, and registrar
  for the `~bls-sync-committee@1.0` device (Service A-202). The harness source
  lives in `k-luecke/bls-verifier` under `bls-device/`.

See [`docs/hyperbeam-bringup.md`](../docs/hyperbeam-bringup.md) for the operator
runbook and [`docs/phase-0-gates.md`](../docs/phase-0-gates.md) for the
explicit gate acceptance criteria.
