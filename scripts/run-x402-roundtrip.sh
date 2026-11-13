#!/usr/bin/env bash
# Prove the x402 paid loop end-to-end over HTTP:
#   buyer client -> A-204 service (REQUIRE_X402=1) -> facilitator (verify+settle)
#
# Default: local MOCK facilitator (real EIP-712 recovery, SIMULATED settlement) —
#   offline, spends nothing. Good for CI and for proving the wiring.
# Real Base Sepolia settlement: set X402_FACILITATOR_URL to a real facilitator
#   (e.g. https://x402.org/facilitator) and fund the payer wallet with testnet
#   USDC. The facilitator pays gas via EIP-3009, so the payer needs USDC only.
#
#   X402_FACILITATOR_URL=https://x402.org/facilitator scripts/run-x402-roundtrip.sh
set -uo pipefail
PAX=$(cd "$(dirname "$0")/.." && pwd)

# Payer key: operator wallet reused from the arb runner unless PRIVATE_KEY is set.
KEY_FILE="${PAXIOM_OPERATOR_KEY_FILE:-$HOME/.paxiom/arb-runner/operator.key}"
if [ -z "${PRIVATE_KEY:-}" ]; then
  [ -f "$KEY_FILE" ] || { echo "ERROR: no PRIVATE_KEY and no key file at $KEY_FILE" >&2; exit 1; }
  PRIVATE_KEY="$(tr -d '[:space:]' < "$KEY_FILE")"
fi
export PRIVATE_KEY

PAYER=$(node -e 'import("viem/accounts").then(m=>console.log(m.privateKeyToAccount("0x"+process.env.PRIVATE_KEY.replace(/^0x/,"")).address))' 2>/dev/null)

export REQUIRE_X402=1
export X402_NETWORK="${X402_NETWORK:-base-sepolia}"
export X402_ASSET="${X402_ASSET:-USDC}"
# Pay-to defaults to the payer itself: a valid EIP-3009 self-transfer that
# settles on-chain without draining the faucet balance across reruns.
export X402_DESTINATION="${X402_DESTINATION:-$PAYER}"
export SIMULATION_SERVICE_PORT="${SIMULATION_SERVICE_PORT:-8094}"

CLEAN=()
cleanup() { for p in "${CLEAN[@]}"; do kill "$p" 2>/dev/null; done; }
trap cleanup EXIT

if [ -z "${X402_FACILITATOR_URL:-}" ]; then
  MODE="mock (simulated settlement)"
  MOCK_PORT="${MOCK_FACILITATOR_PORT:-8099}"
  MOCK_FACILITATOR_PORT="$MOCK_PORT" node "$PAX/scripts/mock-facilitator.mjs" > /tmp/x402-facilitator.log 2>&1 &
  CLEAN+=("$!")
  export X402_FACILITATOR_URL="http://127.0.0.1:$MOCK_PORT"
  for _ in $(seq 1 50); do curl -sf "$X402_FACILITATOR_URL/healthz" >/dev/null 2>&1 && break; sleep 0.2; done
else
  MODE="REAL ($X402_FACILITATOR_URL)"
fi

node "$PAX/services/simulation/server.mjs" > /tmp/x402-service.log 2>&1 &
CLEAN+=("$!")
URL="http://127.0.0.1:$SIMULATION_SERVICE_PORT/v1/simulations"
for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$SIMULATION_SERVICE_PORT/healthz" >/dev/null 2>&1 && break; sleep 0.2; done

echo "=== x402 paid round-trip ==="
echo "payer:       $PAYER"
echo "pay-to:      $X402_DESTINATION"
echo "network:     $X402_NETWORK"
echo "facilitator: $MODE"
echo "service:     A-204 \$0.05 -> $URL"
echo

node "$PAX/services/shared/x402-client.mjs" "$URL" '{"chain":"base","to":"0x2222222222222222222222222222222222222222"}'
RC=$?
echo
if [ $RC -eq 0 ]; then echo "round-trip OK"; else echo "round-trip FAILED (rc=$RC) — see /tmp/x402-facilitator.log, /tmp/x402-service.log"; fi
exit $RC
