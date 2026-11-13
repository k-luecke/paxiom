#!/usr/bin/env bash
# Clean restart of the Paxiom Phase 1 stack.
# Kills any leftover node processes serving the stack, frees ports, then launches.
set -e

echo "Stopping any leftover paxiom processes..."

# Kill anything matching our service paths (precise — won't match the kill cmd itself)
for proc in \
  "services/catalog/server.mjs" \
  "services/load-network/server.mjs" \
  "services/slot-storage-proof/server.mjs" \
  "services/historical-state/server.mjs" \
  "services/cross-chain-message/server.mjs" \
  "services/simulation/server.mjs" \
  "services/arb-engine/server.mjs" \
  "services/price-scanner/server.mjs" \
  "services/unwind-monitor/server.mjs" \
  "services/arb-runner/server.mjs" \
  "services/compliance/server.mjs" \
  "services/sync-committee/server.mjs" \
  "ui/server.js" \
  "sdk/price-feeder.js" \
  "sdk/unwind.js" \
  "sdk/live-executor.js"
do
  pids=$(pgrep -f "node $proc" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "  killing $proc -> $pids"
    kill $pids 2>/dev/null || true
  fi
done

sleep 2

# Verify ports are free
busy=$(ss -tln 2>/dev/null | grep -E ":3000|:808[0-6]|:8090|:8091|:8093|:8094|:8095" || true)
if [ -n "$busy" ]; then
  echo "WARNING: ports still bound after kill:"
  echo "$busy"
  echo "Trying SIGKILL..."
  for proc in services/ ui/server.js sdk/; do
    pids=$(pgrep -f "node.*$proc" 2>/dev/null || true)
    [ -n "$pids" ] && kill -9 $pids 2>/dev/null || true
  done
  sleep 1
fi

echo "Ports free. Launching stack..."
echo
exec bash "$(dirname "$0")/run-phase1-stack.sh"
