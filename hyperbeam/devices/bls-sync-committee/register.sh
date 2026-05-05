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

# Refuse to publish manifest payloads (which include the deploy_key_id) to
# anything other than localhost. HYPERBEAM_REGISTRY_URL accepts only
# loopback hosts; any other host requires explicit operator override.
case "$HYPERBEAM_REGISTRY_URL" in
    http://localhost:*|http://127.0.0.1:*|https://localhost:*|https://127.0.0.1:*)
        ;;
    *)
        if [[ "${HYPERBEAM_ALLOW_REMOTE_REGISTRY:-0}" != "1" ]]; then
            echo "ERROR: HYPERBEAM_REGISTRY_URL is not loopback: $HYPERBEAM_REGISTRY_URL" >&2
            echo "  the manifest contains deploy_key_id; publishing to a remote URL leaks it" >&2
            echo "  set HYPERBEAM_ALLOW_REMOTE_REGISTRY=1 to override" >&2
            exit 4
        fi
        echo "WARNING: publishing manifest to non-loopback URL $HYPERBEAM_REGISTRY_URL" >&2
        ;;
esac

echo "→ registering ~bls-sync-committee@1.0 at $HYPERBEAM_REGISTRY_URL"
curl -fsSL -X POST \
    -H 'Content-Type: application/json' \
    --data-binary "@$MANIFEST" \
    "$HYPERBEAM_REGISTRY_URL/devices"

echo
echo "DONE. Smoke-test:"
echo "  curl -X POST http://localhost:8080/v1/sync-committee/verify -d @<request.json>"
