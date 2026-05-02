#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BATCH="${1:-$ROOT/.paxiom-runtime/expander-keccak-batch.json}"
CHUNK_SIZE="${PAXIOM_EXPANDER_KECCAK_CHUNK_SIZE:-1}"
PCS="${PAXIOM_EXPANDER_PCS:-Raw}"
PROVE_TIMEOUT="${PAXIOM_EXPANDER_PROVE_TIMEOUT_SECONDS:-900}"
PROOF_DIR="$ROOT/.paxiom-runtime/expander-keccak-proofs"
RECEIPT="$ROOT/.paxiom-runtime/expander-keccak-proof-receipt.json"

source "$ROOT/sdk/expander-mpi-env.sh"

PERMUTATION_COUNT="$(node -e 'const b=require(process.argv[1]); console.log(b.permutation_count)' "$BATCH")"
mkdir -p "$PROOF_DIR"

proofs=()
offset=0
while [ "$offset" -lt "$PERMUTATION_COUNT" ]; do
  remaining=$((PERMUTATION_COUNT - offset))
  count="$CHUNK_SIZE"
  if [ "$remaining" -lt "$count" ]; then
    count="$remaining"
  fi

  ADAPTER_DIR="$ROOT/.paxiom-runtime/expander-keccak-adapter-$offset-$count"
  PROOF="$PROOF_DIR/expander-keccak-$offset-$count.bin"

  node "$ROOT/sdk/generate-expander-keccak-adapter.cjs" \
    --batch="$BATCH" \
    --out-dir="$ADAPTER_DIR" \
    --offset="$offset" \
    --count="$count"

  (
    cd "$ADAPTER_DIR"
    go mod tidy
    go run .
  )

  (
    cd "$ROOT/.paxiom-runtime/upstream/Expander"
    timeout "$PROVE_TIMEOUT" cargo run --bin expander-exec --release -- \
      -f SHA256 \
      -p "$PCS" \
      prove \
      -c "$ADAPTER_DIR/circuit.txt" \
      -w "$ADAPTER_DIR/witness.txt" \
      -o "$PROOF"

    timeout "$PROVE_TIMEOUT" cargo run --bin expander-exec --release -- \
      -f SHA256 \
      -p "$PCS" \
      verify \
      -c "$ADAPTER_DIR/circuit.txt" \
      -w "$ADAPTER_DIR/witness.txt" \
      -i "$PROOF"
  )

  proofs+=("$offset:$count:$ADAPTER_DIR:$PROOF")
  offset=$((offset + count))
done

node - "$BATCH" "$RECEIPT" "${proofs[@]}" <<'NODE'
const { statSync, writeFileSync } = require("fs");
const [batchPath, receiptPath, ...proofSpecs] = process.argv.slice(2);
const batch = require(batchPath);
const chunks = proofSpecs.map(spec => {
  const [offset, count, adapterDir, proofPath] = spec.split(":");
  return {
    offset: Number(offset),
    count: Number(count),
    adapter_dir: adapterDir,
    proof: proofPath,
    proof_bytes: statSync(proofPath).size,
    circuit_bytes: statSync(`${adapterDir}/circuit.txt`).size,
    witness_bytes: statSync(`${adapterDir}/witness.txt`).size
  };
});
const receipt = {
  schema: "paxiom.expander_keccak_proof_receipt.v1",
  status: "proved_and_verified",
  batch: batchPath,
  batch_commitment: batch.commitment,
  witness_commitment: batch.witness_commitment,
  permutation_count: batch.permutation_count,
  chunk_count: chunks.length,
  chunks
};
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt, null, 2));
NODE
