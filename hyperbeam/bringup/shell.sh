#!/usr/bin/env bash
# Open a HyperBEAM rebar3 shell with the local device registry on the path.
#
# Inside the shell, dispatch a ping to ~evm@1.0 to prove S.01:
#   1> hb_ao:dispatch(<<"~evm@1.0">>, #{action => ping}).
# A non-error reply is the gate proof.

set -euo pipefail

HYPERBEAM_HOME="${HYPERBEAM_HOME:-${HOME}/HyperBEAM}"
PAXIOM_HOME="${PAXIOM_HOME:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"

if [[ ! -d "$HYPERBEAM_HOME" ]]; then
    echo "ERROR: $HYPERBEAM_HOME not found. Run hyperbeam/bringup/install.sh first."
    exit 1
fi

export PAXIOM_DEVICE_REGISTRY="${PAXIOM_DEVICE_REGISTRY:-$PAXIOM_HOME/hyperbeam/devices}"

echo "→ HYPERBEAM_HOME=$HYPERBEAM_HOME"
echo "→ PAXIOM_DEVICE_REGISTRY=$PAXIOM_DEVICE_REGISTRY"
echo "→ entering rebar3 shell. To prove A-120/S.01:"
echo "    1> hb_ao:dispatch(<<\"~evm@1.0\">>, #{action => ping})."
echo

cd "$HYPERBEAM_HOME"
exec rebar3 shell
