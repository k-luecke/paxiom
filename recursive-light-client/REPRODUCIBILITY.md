# Reproducibility protocol

## Pinned components

- Rust host toolchain: 1.93.0 (`rust-toolchain.toml`)
- SP1 crates and CLI: 6.3.1
- SP1 guest toolchain: selected by SP1 6.3.1
- Protobuf compiler used for the recorded local build: 34.2
- Fixture schema: `paxiom-ethereum-sync-update-fixture-v2`
- Fixture SHA-256: `c097d66a6aa2b2c04787816f94214dc883c6638df444f9a00c3d67b3bf83d9eb`

`Cargo.lock` is committed and SP1 dependencies use exact version requirements.

The workspace uses the default SP1 native host executor. `[profile.dev] debug = 0` avoids a repeatable WSL2 `SIGBUS` during the large host link; it does not alter the guest release profile. On the recorded WSL host, the native runner was also built separately and selected with `SP1_CORE_RUNNER_OVERRIDE_BINARY` to bypass the embedded runner that triggered `SIGBUS`. That override is a WSL-specific host workaround, not part of either guest statement.

## Fresh-clone procedure

Install Rust and SP1 using the official instructions, make `protoc` available, then run:

```bash
cd recursive-light-client
node scripts/verify-fixture.mjs
cargo test -p paxiom-light-client-lib --features serde_json
CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0 cargo check -p paxiom-light-client-script
CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0 \
  cargo run -p paxiom-light-client-script -- execute \
  --fixture fixtures/mainnet-14814119-14814120.json
cargo run -p paxiom-light-client-script -- vkeys --program update
cargo run -p paxiom-light-client-script -- vkeys --program accumulator
```

Or run `scripts/reproduce.sh`. It does not generate proofs unless `PAXIOM_GENERATE_PROOFS=1` is set because compressed proving and recursion require substantially more memory than execution. Deriving each vkey in a separate process prevents the two setup results from being retained simultaneously.

On a WSL host affected by the native-runner `SIGBUS`, set the override before the host build and execution:

```bash
export SP1_CORE_RUNNER_OVERRIDE_BINARY=/absolute/path/to/sp1-core-executor-runner-binary
```

The recorded 5.7 GiB VM still could not complete execution or even one vkey setup. Reproduction of those steps therefore requires a larger Linux host or an authorized proving service; see `BENCHMARKS.md` for the failed-attempt evidence.

## Proof artifact protocol

For each proof artifact, record:

1. SHA-256 and byte size of the proof file;
2. SHA-256 of exact public values;
3. fixture digest;
4. update and accumulator vkey hashes;
5. SP1 version;
6. command and prover backend;
7. generation and verification durations;
8. peak resident memory; and
9. a successful independent `verify` command.

Until those fields are populated in `artifacts/manifest.json`, the corresponding proof claim is not demonstrated.

## Fixture provenance caveat

The capture script fetches finalized, non-optimistic beacon API responses and retrieves the header referenced by each signature block's `parent_root`. Tests independently recompute the attested SSZ roots and verify the signatures. The committee list was fetched from API state `head` during the same committee period; its root is recomputed, but connection of that root to a trusted historical state is not proven.
