#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/sdk/expander-mpi-env.sh"

EXPANDER_ROOT="$ROOT/.paxiom-runtime/upstream/Expander"
OUT="$ROOT/.paxiom-runtime/expander-small-proof.bin"

cd "$EXPANDER_ROOT"

cargo run --bin expander-exec --release -- \
  -f SHA256 \
  -p Orion \
  prove \
  -c ./scripts/small_circuit_m31.circ \
  -w ./scripts/small_witness_m31.circ \
  -o "$OUT"

cargo run --bin expander-exec --release -- \
  -f SHA256 \
  -p Orion \
  verify \
  -c ./scripts/small_circuit_m31.circ \
  -w ./scripts/small_witness_m31.circ \
  -i "$OUT"

ls -lh "$OUT"
