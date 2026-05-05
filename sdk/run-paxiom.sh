#!/bin/bash
echo "Paxiom started - verifying every Ethereum slot"
while true; do
  node "$(dirname "$0")/verify-and-submit.js"
  EXIT_CODE=$?
  echo "Cycle complete (exit code: $EXIT_CODE). Sleeping 6 seconds..."
  sleep 6
done
