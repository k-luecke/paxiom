#!/bin/sh
set -eu

service="${1:-}"

case "$service" in
  ui) entrypoint="ui/server.js" ;;
  catalog) entrypoint="services/catalog/server.mjs" ;;
  sync-committee) entrypoint="services/sync-committee/server.mjs" ;;
  load-network) entrypoint="services/load-network/server.mjs" ;;
  arb-engine) entrypoint="services/arb-engine/server.mjs" ;;
  compliance) entrypoint="services/compliance/server.mjs" ;;
  slot-storage-proof) entrypoint="services/slot-storage-proof/server.mjs" ;;
  cross-chain-message) entrypoint="services/cross-chain-message/server.mjs" ;;
  simulation) entrypoint="services/simulation/server.mjs" ;;
  historical-state) entrypoint="services/historical-state/server.mjs" ;;
  *)
    echo "unknown Paxiom service: $service" >&2
    exit 64
    ;;
esac

exec /usr/bin/node "$entrypoint"
