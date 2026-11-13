#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

command -v node >/dev/null
command -v cargo >/dev/null
command -v cargo-prove >/dev/null
command -v protoc >/dev/null

node scripts/verify-fixture.mjs
cargo test -p paxiom-light-client-lib --features serde_json
CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0 cargo check -p paxiom-light-client-script
CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0 \
  cargo run -p paxiom-light-client-script -- execute \
  --fixture fixtures/mainnet-14814119-14814120.json
cargo run -p paxiom-light-client-script -- vkeys --program update
cargo run -p paxiom-light-client-script -- vkeys --program accumulator

if [[ "${PAXIOM_GENERATE_PROOFS:-0}" == "1" ]]; then
  CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0 \
    cargo run -p paxiom-light-client-script -- prove-base \
    --fixture fixtures/mainnet-14814119-14814120.json \
    --index 0 --output artifacts/proofs/base-14814118.bin
  CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0 \
    cargo run -p paxiom-light-client-script -- prove-seed \
    --fixture fixtures/mainnet-14814119-14814120.json \
    --output artifacts/proofs/checkpoint-2.bin
fi
