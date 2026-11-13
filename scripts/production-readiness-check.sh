#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ENV_FILE=${PAXIOM_ENV_FILE:-"$ROOT_DIR/.paxiom/production.env"}

if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi

cd "$ROOT_DIR"

echo "== syntax checks =="
node --check services/shared/proof-archive.mjs
node --check scripts/proof-archive-verify.mjs
node --check services/slot-storage-proof/server.mjs
node --check services/historical-state/server.mjs

echo
echo "== service tests =="
env \
  -u PAXIOM_DEPLOYMENT_MODE \
  -u PAXIOM_ENV \
  -u PAXIOM_PROOF_ARCHIVE_MODE \
  -u PAXIOM_PROOF_ARCHIVE_DIR \
  -u PAXIOM_PROOF_ARCHIVE_ENCRYPTION_KEY_BASE64 \
  -u PAXIOM_PROOF_ARCHIVE_WAREHOUSE \
  -u PAXIOM_PROOF_ARCHIVE_STORAGE_CLASS \
  -u PAXIOM_PROOF_ARCHIVE_LATENCY_CLASS \
  npm run test:services

if [[ -n "${PAXIOM_PROOF_ARCHIVE_DIR:-}" && -d "${PAXIOM_PROOF_ARCHIVE_DIR:-}" ]]; then
  if find "$PAXIOM_PROOF_ARCHIVE_DIR" -maxdepth 1 -name '*.paxiom-proof.json' -print -quit | grep -q .; then
    echo
    echo "== proof archive integrity =="
    npm run proof-archive:verify -- "$PAXIOM_PROOF_ARCHIVE_DIR"
  else
    echo
    echo "WARN: no proof archive bundles found in $PAXIOM_PROOF_ARCHIVE_DIR"
  fi
fi

echo
echo "== strict preflight shape =="
services=(catalog load-network slot-storage-proof historical-state sync-committee cross-chain-message simulation arb-engine compliance)
for service in "${services[@]}"; do
  if PAXIOM_DEPLOYMENT_MODE=${PAXIOM_DEPLOYMENT_MODE:-testnet} node services/shared/preflight.mjs "$service"; then
    echo "OK $service"
  else
    echo "BLOCKED $service"
  fi
done
