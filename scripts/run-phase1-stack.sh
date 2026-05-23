#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
LOG_DIR=${PAXIOM_STACK_LOG_DIR:-"$ROOT_DIR/log/phase1-stack"}
mkdir -p "$LOG_DIR"

export SERVICE_CATALOG_HOST=${SERVICE_CATALOG_HOST:-127.0.0.1}
export SERVICE_CATALOG_PORT=${SERVICE_CATALOG_PORT:-8090}
export SYNC_COMMITTEE_HOST=${SYNC_COMMITTEE_HOST:-127.0.0.1}
export SYNC_COMMITTEE_PORT=${SYNC_COMMITTEE_PORT:-8080}
export LOAD_NETWORK_SERVICE_HOST=${LOAD_NETWORK_SERVICE_HOST:-127.0.0.1}
export LOAD_NETWORK_SERVICE_PORT=${LOAD_NETWORK_SERVICE_PORT:-8081}
export ARB_ENGINE_HOST=${ARB_ENGINE_HOST:-127.0.0.1}
export ARB_ENGINE_PORT=${ARB_ENGINE_PORT:-8082}
export PRICE_SCANNER_HOST=${PRICE_SCANNER_HOST:-127.0.0.1}
export PRICE_SCANNER_PORT=${PRICE_SCANNER_PORT:-8084}
export UNWIND_MONITOR_HOST=${UNWIND_MONITOR_HOST:-127.0.0.1}
export UNWIND_MONITOR_PORT=${UNWIND_MONITOR_PORT:-8085}
export ARB_RUNNER_HOST=${ARB_RUNNER_HOST:-127.0.0.1}
export ARB_RUNNER_PORT=${ARB_RUNNER_PORT:-8086}
export PAXIOM_DIR=${PAXIOM_DIR:-"$ROOT_DIR"}
export COMPLIANCE_SERVICE_HOST=${COMPLIANCE_SERVICE_HOST:-127.0.0.1}
export COMPLIANCE_SERVICE_PORT=${COMPLIANCE_SERVICE_PORT:-8083}
export SLOT_STORAGE_PROOF_HOST=${SLOT_STORAGE_PROOF_HOST:-127.0.0.1}
export SLOT_STORAGE_PROOF_PORT=${SLOT_STORAGE_PROOF_PORT:-8091}
export CROSS_CHAIN_MESSAGE_HOST=${CROSS_CHAIN_MESSAGE_HOST:-127.0.0.1}
export CROSS_CHAIN_MESSAGE_PORT=${CROSS_CHAIN_MESSAGE_PORT:-8093}
export SIMULATION_SERVICE_HOST=${SIMULATION_SERVICE_HOST:-127.0.0.1}
export SIMULATION_SERVICE_PORT=${SIMULATION_SERVICE_PORT:-8094}
export HISTORICAL_STATE_HOST=${HISTORICAL_STATE_HOST:-127.0.0.1}
export HISTORICAL_STATE_PORT=${HISTORICAL_STATE_PORT:-8095}
export PAXIOM_UI_HOST=${PAXIOM_UI_HOST:-127.0.0.1}
export PAXIOM_UI_PORT=${PAXIOM_UI_PORT:-3000}

services=(
  "catalog:npm run service:catalog"
  "load-network:npm run service:load-network"
  "slot-storage-proof:npm run service:slot-storage-proof"
  "historical-state:npm run service:historical-state"
  "cross-chain-message:npm run service:cross-chain-message"
  "simulation:npm run service:simulation"
  "arb-engine:npm run service:arb-engine"
  "price-scanner:npm run service:price-scanner"
  "unwind-monitor:npm run service:unwind-monitor"
  "arb-runner:npm run service:arb-runner"
  "compliance:npm run service:compliance"
  "sync-committee:npm run service:sync-committee"
  "ui:npm run service:ui"
)

pids=()

cleanup() {
  for pid in "${pids[@]:-}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

for entry in "${services[@]}"; do
  name=${entry%%:*}
  cmd=${entry#*:}
  log="$LOG_DIR/$name.log"
  echo "starting $name -> $log"
  (cd "$ROOT_DIR" && bash -lc "$cmd") >"$log" 2>&1 &
  pids+=("$!")
done

echo
echo "Paxiom Phase 1 stack starting."
echo "UI: http://$PAXIOM_UI_HOST:$PAXIOM_UI_PORT"
echo "Logs: $LOG_DIR"
echo "Press Ctrl-C to stop all services."

wait
