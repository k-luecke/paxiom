#!/usr/bin/env bash
set -e
cd ~/paxiom

PRICE_SCANNER_AUTOSTART=0 node services/price-scanner/server.mjs > /tmp/ps.log 2>&1 &
PS_PID=$!
UNWIND_MONITOR_AUTOSTART=0 node services/unwind-monitor/server.mjs > /tmp/um.log 2>&1 &
UM_PID=$!
node services/arb-runner/server.mjs > /tmp/ar.log 2>&1 &
AR_PID=$!
node ui/server.js > /tmp/ui.log 2>&1 &
UI_PID=$!

cleanup() { kill $PS_PID $UM_PID $AR_PID $UI_PID 2>/dev/null || true; }
trap cleanup EXIT

sleep 3

echo "--- /api/arb/runner-status ---"
curl -s "http://127.0.0.1:3000/api/arb/runner-status"; echo
echo "--- /api/arb/runner-wallet (mainnet RPC calls) ---"
curl -s "http://127.0.0.1:3000/api/arb/runner-wallet" | head -c 600; echo
echo "--- /api/arb/runner-performance ---"
curl -s "http://127.0.0.1:3000/api/arb/runner-performance"; echo
echo "--- /api/services/health ids ---"
curl -s "http://127.0.0.1:3000/api/services/health" | grep -oE '"id":"[^"]+"'
echo "--- /api/arb/emergency-close ---"
curl -s -X POST "http://127.0.0.1:3000/api/arb/emergency-close"; echo
echo "--- /api/arb/runner-status (after emergency) ---"
curl -s "http://127.0.0.1:3000/api/arb/runner-status"; echo
echo "--- /api/arb/runner-start (should be blocked by emergency) ---"
curl -s -X POST -H 'Content-Type: application/json' -d '{"tradeSizeUsd":500}' "http://127.0.0.1:3000/api/arb/runner-start"; echo
echo "--- /api/arb/clear-emergency ---"
curl -s -X POST "http://127.0.0.1:3000/api/arb/clear-emergency"; echo
echo "--- /api/arb/runner-status (after clear) ---"
curl -s "http://127.0.0.1:3000/api/arb/runner-status"; echo
echo "--- /api/arb/external-wallet (vitalik.eth) ---"
curl -s "http://127.0.0.1:3000/api/arb/external-wallet?address=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" | head -c 400; echo
echo "--- /api/arb/preflight (operator wallet, $500 trade) ---"
curl -s "http://127.0.0.1:3000/api/arb/preflight?tradeSizeUsd=500" | head -c 700; echo
echo "--- /api/arb/withdraw (input validation only — bad asset) ---"
curl -s -X POST -H 'Content-Type: application/json' -d '{"chain":"base","asset":"bogus","amount":1,"to":"0x1111111111111111111111111111111111111111"}' "http://127.0.0.1:3000/api/arb/withdraw" | head -c 200; echo
echo "--- /api/arb/withdraw (input validation only — bad address) ---"
curl -s -X POST -H 'Content-Type: application/json' -d '{"chain":"base","asset":"usdc","amount":1,"to":"not-an-address"}' "http://127.0.0.1:3000/api/arb/withdraw" | head -c 200; echo
echo "ok (no broadcasts attempted)"
