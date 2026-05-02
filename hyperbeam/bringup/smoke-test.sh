#!/usr/bin/env bash
# Non-interactive proof of A-120 / S.01: spawn a transient rebar3 shell,
# resolve a path against `~test-device@1.0`, assert a non-error reply.
#
# Original draft of this script targeted `~evm@1.0` via `hb_ao:dispatch/2`.
# Both assumptions turned out to be wrong on upstream `permaweb/HyperBEAM`:
#   - `hb_ao:dispatch/2` does not exist; the AO-Core resolver is `hb_ao:resolve/2`
#   - `~evm@1.0` is a Load HyperBEAM fork (`loadnetwork/load_hb`) device,
#     not part of upstream
# `~test-device@1.0` (`dev_test`) is the canonical "framework is working"
# probe — its own self-description: "Test device for testing the AO-Core
# framework". A successful resolve against it is the right S.01 signal.
#
# Exits 0 on gate-pass; non-zero on any failure. Suitable for CI on the
# operator's own machine (HyperBEAM is not on GitHub Actions runners by default).

set -uo pipefail

HYPERBEAM_HOME="${HYPERBEAM_HOME:-${HOME}/HyperBEAM}"

if [[ ! -d "$HYPERBEAM_HOME" ]]; then
    echo "FAIL: $HYPERBEAM_HOME not found. Run install.sh." >&2
    exit 2
fi

cd "$HYPERBEAM_HOME"

# rebar3 shell --eval evaluates the expression non-interactively and exits.
# We pattern-match on a successful return tuple from hb_ao:resolve/2.
rebar3 shell --eval '
case catch hb_ao:resolve(#{<<"path">> => <<"/~test-device@1.0/info">>}, #{}) of
    {ok, _} -> io:format("S01_OK~n"), erlang:halt(0);
    Other  -> io:format("S01_FAIL ~p~n", [Other]), erlang:halt(1)
end.
' 2>&1
status=$?

if [[ $status -eq 0 ]]; then
    echo "PASS: A-120/S.01 — HyperBEAM ~test-device@1.0 resolve returned ok"
    exit 0
fi

echo "FAIL: rebar3 shell exited $status (no S01_OK in output)" >&2
exit $status
