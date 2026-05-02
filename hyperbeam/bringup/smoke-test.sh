#!/usr/bin/env bash
# Non-interactive proof of A-120 / S.01: spawn a transient rebar3 shell, send
# `hb_ao:dispatch(<<"~evm@1.0">>, ping_message())`, assert a non-error reply.
#
# Exits 0 on gate-pass; non-zero on any failure. Suitable for CI on the
# operator's own machine (HyperBEAM is not on GitHub Actions runners by default).

set -euo pipefail

HYPERBEAM_HOME="${HYPERBEAM_HOME:-${HOME}/HyperBEAM}"

if [[ ! -d "$HYPERBEAM_HOME" ]]; then
    echo "FAIL: $HYPERBEAM_HOME not found. Run install.sh." >&2
    exit 2
fi

cd "$HYPERBEAM_HOME"

# rebar3 shell -e <expr> evaluates the expression non-interactively and exits.
# We pattern-match on a successful return tuple from hb_ao:dispatch/2.
output="$(rebar3 shell --eval '
case catch hb_ao:dispatch(<<"~evm@1.0">>, #{action => ping}) of
    {ok, _} -> io:format("S01_OK~n"), erlang:halt(0);
    Other  -> io:format("S01_FAIL ~p~n", [Other]), erlang:halt(1)
end.
' 2>&1)"
status=$?

echo "$output"

if [[ $status -ne 0 ]]; then
    echo "FAIL: rebar3 shell exited $status" >&2
    exit $status
fi

if echo "$output" | grep -q "S01_OK"; then
    echo "PASS: A-120/S.01 — HyperBEAM ~evm@1.0 dispatch returned ok"
    exit 0
fi

echo "FAIL: did not see S01_OK in output" >&2
exit 1
