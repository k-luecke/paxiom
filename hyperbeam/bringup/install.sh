#!/usr/bin/env bash
# Clone HyperBEAM and fetch its dependencies. Idempotent — safe to re-run.
#
# Closes part of paxiom-static's A-120 / S.01 gate ("HyperBEAM running
# locally"). After this exits 0, run `bringup/shell.sh` to enter rebar3.

set -euo pipefail

HYPERBEAM_HOME="${HYPERBEAM_HOME:-${HOME}/HyperBEAM}"
HYPERBEAM_REPO="${HYPERBEAM_REPO:-https://github.com/permaweb/HyperBEAM.git}"
HYPERBEAM_REF="${HYPERBEAM_REF:-main}"

if ! command -v rebar3 >/dev/null 2>&1; then
    echo "ERROR: rebar3 is required. Install via:"
    echo "  curl -fsSL https://s3.amazonaws.com/rebar3/rebar3 -o /usr/local/bin/rebar3 && chmod +x /usr/local/bin/rebar3"
    exit 1
fi

if ! command -v erl >/dev/null 2>&1; then
    echo "ERROR: erlang/OTP is required (for rebar3 shell). Install OTP 25+."
    exit 1
fi

if [[ ! -d "$HYPERBEAM_HOME/.git" ]]; then
    echo "→ cloning HyperBEAM into $HYPERBEAM_HOME"
    git clone --branch "$HYPERBEAM_REF" "$HYPERBEAM_REPO" "$HYPERBEAM_HOME"
else
    echo "→ HyperBEAM already cloned at $HYPERBEAM_HOME"
fi

echo "→ fetching dependencies"
( cd "$HYPERBEAM_HOME" && rebar3 get-deps )

echo
echo "DONE. Next:"
echo "  HYPERBEAM_HOME=$HYPERBEAM_HOME ./hyperbeam/bringup/shell.sh"
