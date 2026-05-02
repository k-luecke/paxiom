#!/usr/bin/env bash
# Register the ~bls-sync-committee@1.0 device with a running HyperBEAM node.
#
# Assumes hyperbeam/bringup/shell.sh has been run in another terminal and
# the rebar3 shell is listening on $HYPERBEAM_REGISTRY_URL (default below).

set -euo pipefail

MANIFEST="${1:-$(dirname "$0")/manifest.json}"
HYPERBEAM_REGISTRY_URL="${HYPERBEAM_REGISTRY_URL:-http://localhost:8080/registry}"

if [[ ! -f "$MANIFEST" ]]; then
    echo "ERROR: manifest not found: $MANIFEST" >&2
    exit 2
fi

# Verify wasm checksum if the file is present in the same dir.
WASM="$(dirname "$MANIFEST")/bls_verifier.wasm"
SUM="${WASM}.sha256"
if [[ -f "$WASM" && -f "$SUM" ]]; then
    expected="$(awk '{print $1}' "$SUM")"
    actual="$(sha256sum "$WASM" | awk '{print $1}')"
    if [[ "$expected" != "$actual" ]]; then
        echo "ERROR: wasm checksum mismatch" >&2
        echo "  expected: $expected" >&2
        echo "  actual:   $actual" >&2
        echo "  refresh per UPDATE.md" >&2
        exit 3
    fi
fi

echo "→ registering ~bls-sync-committee@1.0 at $HYPERBEAM_REGISTRY_URL"
curl -fsSL -X POST \
    -H 'Content-Type: application/json' \
    --data-binary "@$MANIFEST" \
    "$HYPERBEAM_REGISTRY_URL/devices"

echo
echo "DONE. Smoke-test:"
echo "  curl -X POST http://localhost:8080/v1/sync-committee/verify -d @<request.json>"
