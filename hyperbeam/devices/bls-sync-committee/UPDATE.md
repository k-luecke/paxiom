# Refreshing the vendored `bls_verifier.wasm`

The wasm in this directory is a vendored copy of the artifact built from
[`k-luecke/bls-verifier`](https://github.com/k-luecke/bls-verifier). The
canonical source lives there; this is a deployment input.

## When to refresh

- A new fork is approaching and `bls-device` ships a fix-version-related fix
- The cdylib gets a security update
- A reproducible-build watermark in CI changes (drift)

## Procedure

```bash
# 1. Build the wasm in the bls-verifier checkout.
cd ~/bls-verifier
git pull
cargo build --release --target wasm32-unknown-unknown -p bls-verifier

# 2. Copy artifact + checksum into this directory.
WASM_SRC=target/wasm32-unknown-unknown/release/bls_verifier.wasm
WASM_DST=~/paxiom/hyperbeam/devices/bls-sync-committee/bls_verifier.wasm
cp "$WASM_SRC" "$WASM_DST"
sha256sum "$WASM_DST" | awk '{print $1}' > "${WASM_DST}.sha256"

# 3. Commit both files together (the CI hash check fails if they drift).
cd ~/paxiom
git add hyperbeam/devices/bls-sync-committee/bls_verifier.wasm \
        hyperbeam/devices/bls-sync-committee/bls_verifier.wasm.sha256
git commit -m "hyperbeam/bls-sync-committee: refresh wasm to <bls-verifier-rev>"
```

## CI hash check

`.github/workflows/services.yml` runs `sha256sum -c bls_verifier.wasm.sha256`
on every push and fails if the wasm and checksum disagree. This catches the
case where one is updated without the other.
