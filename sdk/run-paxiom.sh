#!/bin/bash
echo "Paxiom started - verifying every Ethereum slot"
while true; do
  node /home/mk19/paxiom/sdk/verify-and-submit.js
  EXIT_CODE=$?
  echo "Cycle complete (exit code: $EXIT_CODE). Sleeping 6 seconds..."
  sleep 6
done
