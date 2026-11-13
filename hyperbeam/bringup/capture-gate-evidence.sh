#!/usr/bin/env bash
# Capture evidence of a successful Phase 0 gate close: hit the running
# sync-committee service against a real beacon slot and record the slot
# number, timestamp, and response hash to a permanent JSON record.
#
# Used as the operator-side proof for paxiom-static A-120/S.02 — the file
# this writes is the artifact a future CA.02 sheet will reference.
#
# Usage:
#   ./hyperbeam/bringup/capture-gate-evidence.sh
#       [--service-url http://127.0.0.1:8080]
#       [--beacon-url https://lodestar-mainnet.chainsafe.io]
#       [--slot <historical-slot>]                # default: current head
#
# Writes hyperbeam/bringup/evidence/gate-s02-<UTC-timestamp>.json with
# slot, beacon_endpoint, service_endpoint, request_hash (sha256 of the
# request body), response (full VerifyResponse JSON), captured_at, and
# git rev. The directory is gitignored — this is operator-local evidence,
# not committed.

set -euo pipefail

SERVICE_URL="http://127.0.0.1:8080"
BEACON_URL="https://lodestar-mainnet.chainsafe.io"
SLOT=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --service-url) SERVICE_URL="$2"; shift 2 ;;
        --beacon-url)  BEACON_URL="$2";  shift 2 ;;
        --slot)        SLOT="$2";        shift 2 ;;
        *) echo "unknown arg: $1" >&2; exit 2 ;;
    esac
done

for cmd in curl jq sha256sum; do
    command -v "$cmd" >/dev/null 2>&1 || { echo "ERROR: $cmd required" >&2; exit 2; }
done

ts="$(date -u +%Y%m%dT%H%M%SZ)"
out_dir="$(dirname "$0")/evidence"
mkdir -p "$out_dir"
out_file="$out_dir/gate-s02-${ts}.json"

echo "→ resolving slot"
if [[ -z "$SLOT" ]]; then
    head=$(curl -fsSL "$BEACON_URL/eth/v1/beacon/headers/head")
    SLOT=$(echo "$head" | jq -r '.data.header.message.slot')
fi
echo "→ slot: $SLOT"

echo "→ fetching block + header"
header=$(curl -fsSL "$BEACON_URL/eth/v1/beacon/headers/$SLOT")
block=$(curl -fsSL "$BEACON_URL/eth/v2/beacon/blocks/$SLOT")

req=$(jq -n \
    --arg slot "$SLOT" \
    --arg block_root "$(echo "$header" | jq -r '.data.root')" \
    --arg parent_root "$(echo "$block" | jq -r '.data.message.parent_root')" \
    --arg bits "$(echo "$block" | jq -r '.data.message.body.sync_aggregate.sync_committee_bits')" \
    --arg sig "$(echo "$block" | jq -r '.data.message.body.sync_aggregate.sync_committee_signature')" \
    '{
       slot: $slot,
       block_root: $block_root,
       parent_root: $parent_root,
       sync_aggregate: { sync_committee_bits: $bits, sync_committee_signature: $sig }
     }')

req_hash=$(printf '%s' "$req" | sha256sum | awk '{print $1}')

echo "→ POST to $SERVICE_URL/v1/sync-committee/verify"
resp=$(curl -fsSL -X POST -H 'Content-Type: application/json' \
    --data "$req" \
    "$SERVICE_URL/v1/sync-committee/verify")

verified=$(echo "$resp" | jq -r '.verified')

jq -n \
    --arg gate "A-120/S.02" \
    --arg slot "$SLOT" \
    --arg beacon "$BEACON_URL" \
    --arg service "$SERVICE_URL" \
    --arg req_hash "$req_hash" \
    --argjson resp "$resp" \
    --arg captured_at "$ts" \
    --arg git_rev "$(git rev-parse HEAD 2>/dev/null || echo 'not-a-git-checkout')" \
    --arg verified "$verified" \
    '{
       gate: $gate,
       slot: $slot,
       beacon_endpoint: $beacon,
       service_endpoint: $service,
       request_hash: $req_hash,
       response: $resp,
       verified: ($verified == "true"),
       captured_at_utc: $captured_at,
       git_rev: $git_rev
     }' > "$out_file"

echo "→ evidence: $out_file"
echo "→ verified: $verified"

if [[ "$verified" != "true" ]]; then
    echo "FAIL: response verified=false. Inspect $out_file." >&2
    exit 1
fi
