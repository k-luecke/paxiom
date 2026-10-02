# Lab C AO distributed runner

Prototype coordination layer for intentionally published cryptographic puzzles.

This first cut deliberately separates **coordination correctness** from the
cryptographic kernel. The coordinator creates deterministic, non-overlapping
integer shards. Workers return exhaustion/found records. The reducer only
certifies a run when every interval in `[0,N)` is covered exactly once.

## Safety / Lab C invariants

- public puzzle/challenge targets only
- no wallet broadcast or claim action
- no recovered secret is written into coordinator state
- a hit is returned as a commitment/reference, never plaintext secret
- exact candidate-family and kernel digests travel with every shard/result

## Message protocol

Coordinator actions:

- `CreateRun`
- `LeaseShard`
- `SubmitShard`
- `GetRun`

A run is parameterized by:

- `run_id`
- `target_id`
- `family_digest`
- `kernel_digest`
- `candidate_count`
- `shard_size`

Each shard is a half-open interval `[start_index,end_index)`. Workers
deterministically regenerate candidates from indices; candidate strings do not
need to be sent over AO.

## First benchmark

Use a synthetic known-answer family before any live puzzle:

1. Run locally with one worker.
2. Run the identical frozen family through AO with increasing worker counts.
3. Require exact coverage and the known hit commitment.
4. Measure wall time, aggregate candidate evaluations, duplicate evaluations,
   failed/expired leases, and coordination overhead.

The cryptographic hot loop belongs in Rust/WASM. Lua owns leases, state,
coverage and reduction.
