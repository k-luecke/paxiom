#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${SYNC_COMMITTEE_PORT:-8096}"
LOG="${A202_SERVICE_LOG:-/tmp/paxiom-a202-local-testnet.log}"

if [[ -z "${PAXIOM_TESTNET_BUYER_PRIVATE_KEY:-}" ]]; then
  read -r -s -p "Base Sepolia buyer private key (0x..., hidden): " PAXIOM_TESTNET_BUYER_PRIVATE_KEY
  echo
  export PAXIOM_TESTNET_BUYER_PRIVATE_KEY
fi

if [[ -z "${X402_PAY_TO:-}" && -z "${PAXIOM_RECEIVING_WALLET:-}" ]]; then
  read -r -p "Receiving wallet address (0x...): " X402_PAY_TO
  export X402_PAY_TO
fi

export SYNC_COMMITTEE_HOST="${SYNC_COMMITTEE_HOST:-127.0.0.1}"
export SYNC_COMMITTEE_PORT="$PORT"
export REQUIRE_X402=1
export X402_MODE=testnet
export X402_NETWORK=eip155:84532
export X402_PRICE="${X402_PRICE:-\$0.001}"
export X402_PAY_TO="${X402_PAY_TO:-${PAXIOM_RECEIVING_WALLET:-}}"
export X402_SYNC_FACILITATOR_ON_START=1
export PAXIOM_ALLOW_EPHEMERAL_PLATFORM_KEY="${PAXIOM_ALLOW_EPHEMERAL_PLATFORM_KEY:-1}"
export BLS_DEVICE_VIA_SUBPROCESS=1
export BLS_DEVICE_HARNESS="${BLS_DEVICE_HARNESS:-/home/kyle_w_luecke/bls-verifier-step0-wt/target/release/bls-device-harness}"
export BLS_DEVICE_BEACON_LODESTAR="${BLS_DEVICE_BEACON_LODESTAR:-https://ethereum-beacon-api.publicnode.com}"
export BLS_DEVICE_CACHE_PATH="${BLS_DEVICE_CACHE_PATH:-/tmp/paxiom-a202-testnet-committees.sqlite}"
export A202_URL="http://${SYNC_COMMITTEE_HOST}:${PORT}/v1/sync-committee/verify"

rm -f "$LOG"
node services/sync-committee/server.mjs >"$LOG" 2>&1 &
PID=$!

cleanup() {
  kill "$PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

for _ in $(seq 1 80); do
  if curl -sSf "http://${SYNC_COMMITTEE_HOST}:${PORT}/healthz" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

if ! kill -0 "$PID" >/dev/null 2>&1; then
  echo "A-202 service exited before becoming healthy. Log:"
  cat "$LOG"
  exit 1
fi

echo "A-202 local testnet service is up at ${A202_URL}"
npm run a202:paid-testnet

echo
echo "Service log: $LOG"
