#!/usr/bin/env bash
# A-202 subprocess-mode acceptance script (Slice 1A).
#
# Boots services/sync-committee/server.mjs against a real bls-device-harness
# binary, POSTs a sync committee request, and asserts the response envelope
# is correctly shaped, ed25519-signed, and not synthesised. Also enforces
# the Slice 1A truth invariants emitted by the harness:
#   - settlement_verified is false
#   - notary_status is not durable/production/tee-backed
#   - x402_mode is disabled or stub
#
# Required env:
#   BLS_DEVICE_HARNESS                       absolute path to harness binary
#   PAXIOM_RESPONSE_SIGNING_PRIVATE_KEY_PEM  paxiom outer-envelope ed25519 PEM
#                                            (file content, not a path)
#
# Optional env:
#   PORT                       paxiom listen port (default 7402)
#   FIXTURE                    request fixture
#                              (default fixtures/sync-committee/known-good-request.json)
#   EXPECTED_VERIFIED          if set ('true' or 'false'), asserted against verdict
#   BLS_DEVICE_X402_MODE       passed through to harness (default 'disabled')
#   EVIDENCE_ROOT              default evidence/A-202
#
# Exit 0 only on PASS. Evidence under $EVIDENCE_ROOT/<unix_ts>-<request_sha8>/.

set -euo pipefail

require_env() {
  if [[ -z "${!1:-}" ]]; then
    echo "ERR: $1 required" >&2
    exit 2
  fi
}
require_env BLS_DEVICE_HARNESS
require_env PAXIOM_RESPONSE_SIGNING_PRIVATE_KEY_PEM

[[ -x "$BLS_DEVICE_HARNESS" ]] \
  || { echo "ERR: BLS_DEVICE_HARNESS=$BLS_DEVICE_HARNESS not executable" >&2; exit 2; }

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
PORT=${PORT:-7402}
FIXTURE=${FIXTURE:-$ROOT_DIR/fixtures/sync-committee/known-good-request.json}
EVIDENCE_ROOT=${EVIDENCE_ROOT:-$ROOT_DIR/evidence/A-202}
EXPECTED_VERIFIED=${EXPECTED_VERIFIED:-}

[[ -f "$FIXTURE" ]] || { echo "ERR: fixture missing: $FIXTURE" >&2; exit 2; }

REQ_SHA=$(sha256sum "$FIXTURE" | cut -d' ' -f1)
TS=$(date +%s)
EVIDENCE_DIR=$EVIDENCE_ROOT/$TS-${REQ_SHA:0:8}
mkdir -p "$EVIDENCE_DIR"
cp "$FIXTURE" "$EVIDENCE_DIR/request.json"

GIT_COMMIT=$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null || echo "unknown")
cat > "$EVIDENCE_DIR/meta.json" <<META
{
  "started_at": $TS,
  "git_commit": "$GIT_COMMIT",
  "harness_path": "$BLS_DEVICE_HARNESS",
  "fixture": "$FIXTURE",
  "request_sha256": "$REQ_SHA",
  "expected_verified": "$EXPECTED_VERIFIED",
  "x402_mode": "${BLS_DEVICE_X402_MODE:-disabled}",
  "paxiom_port": $PORT
}
META

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

export MOCK_DEVICE=0
export BLS_DEVICE_VIA_SUBPROCESS=1
export REQUIRE_X402=0
export PAXIOM_RESPONSE_SIGNING_KEY_ID=${PAXIOM_RESPONSE_SIGNING_KEY_ID:-paxiom-testnet-response-key-001}
export PORT
export BLS_DEVICE_X402_MODE=${BLS_DEVICE_X402_MODE:-disabled}

node "$ROOT_DIR/services/sync-committee/server.mjs" \
  > "$EVIDENCE_DIR/server.stdout" 2> "$EVIDENCE_DIR/server.stderr" &
SERVER_PID=$!

# Wait up to 10s for server to bind.
for _ in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

HTTP_STATUS=$(curl -sS -o "$EVIDENCE_DIR/response.json" -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  --data @"$FIXTURE" \
  "http://127.0.0.1:$PORT/v1/sync-committee/verify" || echo "000")

RESP_SHA=$(sha256sum "$EVIDENCE_DIR/response.json" | cut -d' ' -f1)
TMP=$(mktemp)
jq --arg http "$HTTP_STATUS" \
   --arg resp_sha "$RESP_SHA" \
   --argjson finished_at "$(date +%s)" \
   '. + {http_status: ($http|tonumber), response_sha256: $resp_sha, finished_at: $finished_at}' \
   "$EVIDENCE_DIR/meta.json" > "$TMP" && mv "$TMP" "$EVIDENCE_DIR/meta.json"

fail() {
  echo "FAIL: $*" >&2
  echo "Evidence: $EVIDENCE_DIR" >&2
  exit 1
}

[[ "$HTTP_STATUS" == "200" ]] || fail "HTTP $HTTP_STATUS (expected 200)"

# Outer envelope.
SERVICE=$(jq -r '.envelope.service // empty' "$EVIDENCE_DIR/response.json")
[[ "$SERVICE" == "A-202" ]] || fail "envelope.service != A-202 (got '$SERVICE')"

ALG=$(jq -r '.envelope.platformSignature.algorithm // empty' "$EVIDENCE_DIR/response.json")
[[ "$ALG" == "ed25519" ]] || fail "platformSignature.algorithm != ed25519 (got '$ALG')"

KEY_ID=$(jq -r '.envelope.platformSignature.keyId // empty' "$EVIDENCE_DIR/response.json")
[[ -n "$KEY_ID" ]] || fail "envelope.platformSignature.keyId empty"

if grep -Eq '"algorithm"[[:space:]]*:[[:space:]]*"dev"' "$EVIDENCE_DIR/response.json"; then
  fail 'response contains algorithm:"dev" (forbidden)'
fi

# Inner harness envelope (under artifact.payload).
MOCK=$(jq -r '.artifact.payload.mock // "absent"' "$EVIDENCE_DIR/response.json")
[[ "$MOCK" == "false" || "$MOCK" == "absent" ]] \
  || fail "artifact.payload.mock must be false or absent (got '$MOCK')"

SETTLEMENT=$(jq -r '.artifact.payload.settlement_verified' "$EVIDENCE_DIR/response.json")
[[ "$SETTLEMENT" == "false" ]] \
  || fail "settlement_verified must be false in Slice 1A (got '$SETTLEMENT')"

KEY_SCOPE=$(jq -r '.artifact.payload.key_scope // empty' "$EVIDENCE_DIR/response.json")
case "$KEY_SCOPE" in
  ephemeral-subprocess|operator-supplied) ;;
  *) fail "key_scope unexpected (got '$KEY_SCOPE')";;
esac

NOTARY=$(jq -r '.artifact.payload.notary_status // empty' "$EVIDENCE_DIR/response.json")
case "$NOTARY" in
  not-persistent|operator-supplied) ;;
  durable|production|tee-backed)
    fail "notary_status forbidden in Slice 1A: '$NOTARY'";;
  *) fail "notary_status unexpected (got '$NOTARY')";;
esac

X402_MODE=$(jq -r '.artifact.payload.x402_mode // empty' "$EVIDENCE_DIR/response.json")
case "$X402_MODE" in
  disabled|stub) ;;
  *) fail "x402_mode unexpected (got '$X402_MODE')";;
esac

VERIFIED=$(jq -r '.artifact.payload.verified' "$EVIDENCE_DIR/response.json")
echo "harness verdict: verified=$VERIFIED  x402_mode=$X402_MODE  key_scope=$KEY_SCOPE"

if [[ -n "$EXPECTED_VERIFIED" ]]; then
  [[ "$VERIFIED" == "$EXPECTED_VERIFIED" ]] \
    || fail "verified mismatch: expected '$EXPECTED_VERIFIED' got '$VERIFIED'"
fi

echo "PASS — evidence: $EVIDENCE_DIR"
