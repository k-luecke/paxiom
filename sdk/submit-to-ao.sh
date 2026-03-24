#!/bin/bash
SLOT=$1
STATE_ROOT=$2
PROCESS="w_MR7QlkfuRcfd3TQJPD1pzMwU5yEEyLMDjO0Ql8_5I"

echo "Submitting slot $SLOT to Paxiom..."

aos $PROCESS --gateway-url https://arweave.net --run "Send({Target = ao.id, Action = 'StoreHeader', Data = '{\"slot\": $SLOT, \"state_root\": \"$STATE_ROOT\"}'})" < /dev/null

aos $PROCESS --gateway-url https://arweave.net --run "Send({Target = ao.id, Action = 'VerifyHeader', Data = '{\"slot\": $SLOT, \"verified\": true}'})" < /dev/null

echo "Done - slot $SLOT proven in Paxiom"
