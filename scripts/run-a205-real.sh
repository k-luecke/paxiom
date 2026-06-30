#!/usr/bin/env bash
# Boot A-205 (Verified Historical State) with the REAL stack and prove it
# end-to-end over HTTP, no mocks:
#   real eth_getProof source -> local MPT verify -> encrypted proof archive
#   -> Ed25519-signed envelope.
#
# Persistent operator secrets are generated once into ~/.paxiom (off-repo,
# gitignored) and reused. The eth_getProof source is transport, not authority —
# the MPT verifier is the trust anchor — so any archive RPC works (public,
# self-hosted Erigon/Reth, or Load Network when its proof API is production).
set -uo pipefail
PAX=$(cd "$(dirname "$0")/.." && pwd)
SECRETS="${PAXIOM_SECRETS_DIR:-$HOME/.paxiom}"
mkdir -p "$SECRETS" "$SECRETS/proof-archive"

SIGN_PEM="$SECRETS/response-signing.ed25519.pem"
[ -f "$SIGN_PEM" ] || { openssl genpkey -algorithm ed25519 -out "$SIGN_PEM" 2>/dev/null; echo "generated signing key: $SIGN_PEM"; }
ENC_KEY_FILE="$SECRETS/proof-archive.key.b64"
[ -f "$ENC_KEY_FILE" ] || { openssl rand -base64 32 > "$ENC_KEY_FILE"; echo "generated archive key: $ENC_KEY_FILE"; }

export PAXIOM_RESPONSE_SIGNING_PRIVATE_KEY_PEM="$(cat "$SIGN_PEM")"
export PAXIOM_RESPONSE_SIGNING_KEY_ID="${PAXIOM_RESPONSE_SIGNING_KEY_ID:-paxiom-a205-prod-key-001}"
export PAXIOM_PROOF_ARCHIVE_ENCRYPTION_KEY_BASE64="$(cat "$ENC_KEY_FILE")"
export PAXIOM_PROOF_ARCHIVE_KEY_ID="${PAXIOM_PROOF_ARCHIVE_KEY_ID:-paxiom-a205-archive-key-001}"

export PAXIOM_STATE_SOURCE=erigon
export PAXIOM_ERIGON_RPC_URL="${PAXIOM_ERIGON_RPC_URL:-https://eth.drpc.org}"
export PAXIOM_PROOF_ARCHIVE_MODE=local
export PAXIOM_PROOF_ARCHIVE_DIR="$SECRETS/proof-archive"
export PAXIOM_PROOF_ARCHIVE_REQUIRED=1
export HISTORICAL_STATE_PORT="${HISTORICAL_STATE_PORT:-8095}"
unset REQUIRE_X402

BLOCK="${1:-19000000}"
ADDR="${2:-0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2}"
SLOT="${3:-0x0}"

node "$PAX/services/historical-state/server.mjs" > /tmp/a205.log 2>&1 &
SVC=$!
trap 'kill $SVC 2>/dev/null' EXIT
for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$HISTORICAL_STATE_PORT/healthz" >/dev/null 2>&1 && break; sleep 0.2; done

echo "=== A-205 query: $ADDR @ block $BLOCK slot $SLOT ==="
curl -sS -X POST "http://127.0.0.1:$HISTORICAL_STATE_PORT/v1/historical-state/query" \
  -H 'Content-Type: application/json' \
  -d "{\"blockNumber\":$BLOCK,\"address\":\"$ADDR\",\"slot\":\"$SLOT\"}" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(JSON.stringify({service:r.service,verified:r.artifact?.payload?.verified,value:r.artifact?.payload?.value,source:r.artifact?.payload?.source,archive:r.auditRecord?.status,archiveRef:r.auditRecord?.archive?.storageRef,sig:r.platformSignature?.algorithm,keyId:r.platformSignature?.keyId},null,2));});'
