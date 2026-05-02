# HyperBEAM Bring-up

Closes Phase 0 / A-120 / S.01. After this runbook, the operator has
HyperBEAM running locally and can register Paxiom devices against it.

## Prerequisites

- Erlang/OTP 25+ — `erl -version`
- rebar3 — `rebar3 -v`
- git, curl, sha256sum

If any are missing:

```bash
# Erlang on Ubuntu
sudo apt-get install -y erlang

# rebar3
curl -fsSL https://s3.amazonaws.com/rebar3/rebar3 -o /usr/local/bin/rebar3
sudo chmod +x /usr/local/bin/rebar3
```

## Step 1 — Clone HyperBEAM

```bash
./hyperbeam/bringup/install.sh
```

This:
1. Clones <https://github.com/permaweb/HyperBEAM> into `$HYPERBEAM_HOME`
   (default `~/HyperBEAM`).
2. Runs `rebar3 get-deps`.

Idempotent — safe to re-run.

## Step 2 — Open the rebar3 shell

```bash
HYPERBEAM_HOME=~/HyperBEAM ./hyperbeam/bringup/shell.sh
```

Inside the shell, the gate proof:

```erlang
1> hb_ao:dispatch(<<"~evm@1.0">>, #{action => ping}).
{ok, _}
```

Any `{ok, _}` return closes A-120 / S.01.

## Step 3 — Smoke-test non-interactively

```bash
HYPERBEAM_HOME=~/HyperBEAM ./hyperbeam/bringup/smoke-test.sh
# expected: PASS: A-120/S.01 — HyperBEAM ~evm@1.0 dispatch returned ok
```

Suitable for CI on the operator's machine; HyperBEAM itself is not on the
GitHub Actions Ubuntu runners.

## Step 4 — Register the BLS device

Once HyperBEAM is up:

```bash
# In another terminal
./hyperbeam/devices/bls-sync-committee/register.sh
```

This POSTs `manifest.json` to the local HyperBEAM registry at
`$HYPERBEAM_REGISTRY_URL` (default `http://localhost:8080/registry`).

Refresh the vendored wasm first if needed — see
[`../hyperbeam/devices/bls-sync-committee/UPDATE.md`](../hyperbeam/devices/bls-sync-committee/UPDATE.md).

## Step 5 — Run the sync-committee service

```bash
node services/sync-committee/server.mjs
# listening on http://127.0.0.1:8080
```

Smoke from another terminal:

```bash
curl -fsSL http://127.0.0.1:8080/healthz
# {"ok":true,"service":"A-202"}
```

For a real verification, build a request from the current beacon head and
POST it to `/v1/sync-committee/verify`. Expected response shape is
documented in [`services/sync-committee/schema.mjs`](../services/sync-committee/schema.mjs)
and matches O-701 / S.02.

## Troubleshooting

- **`rebar3 shell` hangs.** The dependencies haven't finished compiling.
  Tail `_build/default/lib/*/c_src/*.log`; rerun `rebar3 get-deps && rebar3 compile`.
- **`hb_ao` dispatch returns `{error, no_device, _}`.** The
  `~evm@1.0` device isn't loaded. Check the HyperBEAM `config/sys.config`
  for the device list, or see the upstream HyperBEAM README.
- **`register.sh` 404s.** The local registry isn't on `:8080`. Set
  `HYPERBEAM_REGISTRY_URL` to your node's actual registry URL.
