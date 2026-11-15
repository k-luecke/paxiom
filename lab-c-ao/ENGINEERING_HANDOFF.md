# Lab C AO Distributed Runner — Engineering Handoff

**Status:** prototype coordination layer complete; AO/WASM execution bridge is the next blocking milestone  
**Branch:** `lab-c-ao-runner`  
**Repository:** `k-luecke/paxiom`  
**Scope:** intentionally published cryptographic puzzles/challenges only

## 1. Mission

Turn Lab C's bounded puzzle-search runner into a reusable AO/HyperBEAM distributed compute backend.

Immediate objective:

```
Coordinator
    -> deterministic shard lease
    -> AO worker
    -> Rust/WASM search kernel
    -> WasmShardResult
    -> coordinator/reducer
```

The practical success criterion is not an asymptotic cryptographic result. It is:

> Reduce wall-clock time for a frozen bounded candidate family at negligible monetary cost while preserving exact search accounting, reproducibility, and secret quarantine.

After this baseline works, adaptive global -> local -> global scheduling can be layered on top.

## 2. What Already Exists

### `lab-c-ao/coordinator.lua`

AO coordinator implementing:

- deterministic half-open shards `[start_index,end_index)`
- immutable run identity via `run_id`
- `target_id`, `family_digest`, and `kernel_digest`
- configurable shard size
- worker leases
- lease expiration and automatic requeue
- per-attempt lease tokens
- stale-worker rejection after a shard has been re-leased
- exact tested-count validation
- family/kernel digest validation
- result-digest requirement
- plaintext-secret rejection
- hit commitments rather than plaintext secrets
- aggregate run status

Current actions:

- `CreateRun`
- `LeaseShard`
- `SubmitShard`
- `RequeueExpired`
- `GetRun`

A lease token is regenerated for every attempt. A worker that wakes after its lease expired cannot submit against a later lease.

### `lab-c-ao/worker.lua`

AO worker transport/process scaffold.

Current actions:

- `ConfigureWorker`
- `StartWorker`
- receives `ShardLease`
- emits `ExecuteWasmShard`
- receives `WasmShardResult`
- emits `SubmitShard`

It validates family/kernel digests before execution and rejects plaintext secret material before forwarding a result.

**Important:** `ExecuteWasmShard -> actual WASM invocation -> WasmShardResult` is currently an interface seam, not a completed execution path.

### `lab-c-ao/rust-worker/`

Rust deterministic search-kernel scaffold.

Current synthetic kernel:

- deterministic candidate generation from integer index
- known-answer synthetic oracle
- exact `tested` count
- optional hit index
- hit commitment
- deterministic result digest
- unit tests for hit/no-hit intervals
- native CLI in `src/main.rs`

The synthetic kernel exists specifically so the distributed infrastructure can be validated before attaching a live puzzle oracle.

### Tests / benchmark material

- `lab-c-ao/tests/test_partition.py`
- `lab-c-ao/tests/test_lease_model.py`
- `lab-c-ao/BENCHMARK.md`
- `lab-c-ao/protocol.schema.json`

Partition tests cover representative search sizes including 3,456, 4,608, and 181,440.

## 3. Existing Paxiom Lineage to Reuse

Paxiom already contains a closely related Lua/Rust integration seam:

```
hyperbeam/devices/bls-sync-committee/
    manifest.json
    harness/dispatch.lua
```

and:

```
ao-processes/verifier.lua
```

The BLS device layout demonstrates the intended separation:

```
HyperBEAM/AO message world
        |
        v
Lua dispatch/glue
        |
        v
Rust cryptographic implementation
```

Do not copy the BLS implementation blindly. Reuse its packaging/integration pattern.

The canonical AO-side BLS WASM lineage is under `ao-processes/bls_verifier.wasm`; the HyperBEAM manifest historically documented the separate vendored-WASM seam. Treat this as architectural precedent, not proof that the new Lab C worker is wired.

## 4. Immediate Blocking Task

Implement the real bridge:

```
ExecuteWasmShard
        |
        v
Rust/WASM invocation
        |
        v
WasmShardResult
```

A successful result envelope must contain enough information for `SubmitShard`:

```json
{
  "run_id": "...",
  "shard_id": 1,
  "lease_token": "...",
  "family_digest": "...",
  "kernel_digest": "...",
  "tested": 1024,
  "result_digest": "...",
  "hit_commitment": null
}
```

Never return a plaintext winning key/seed/mnemonic through AO.

## 5. Recommended Build Sequence

### Gate A — Build Rust to WASM

1. Ensure the required target is installed:
   `rustup target add wasm32-unknown-unknown`
2. Build the worker:
   `cargo build --release --target wasm32-unknown-unknown`
3. Record SHA-256 of the produced WASM.
4. Make that SHA-256 the `kernel_digest` used by the coordinator/worker.
5. Do not proceed if the digest used in AO does not equal the actual artifact digest.

The existing Rust library may require a thin ABI/export layer depending on the selected AO/HyperBEAM WASM invocation mechanism.

### Gate B — Define the WASM ABI

Prefer a deliberately small interface.

Input:

```
run_id
start_index
end_index
synthetic known-answer parameter (test mode only)
```

Output:

```
tested
result_digest
hit_commitment | null
```

Keep coordinator metadata such as `family_digest`, `kernel_digest`, `lease_token`, and `shard_id` in the Lua transport unless the WASM kernel needs them for its own commitment calculation.

### Gate C — Connect AO worker

Replace/fulfill the current `ExecuteWasmShard` seam in `worker.lua`.

Required behavior:

1. Receive lease.
2. Invoke WASM with exactly that half-open range.
3. Parse result.
4. Attach original run/shard/lease/digest metadata.
5. Emit `WasmShardResult`.
6. Never log or persist plaintext secret material.

### Gate D — Single-worker known-answer run

Do not scale until one AO worker can complete an entire synthetic run.

Verify:

- candidate count exactly equals `N`
- expected known-answer commitment appears
- result digest is deterministic across repeated runs
- coordinator reaches `complete=true`
- no gaps
- no duplicate accepted completion

### Gate E — Failure injection

Before scaling, deliberately:

- kill a worker after leasing a shard
- wait for lease expiry
- allow another worker to inherit it
- submit the old worker's stale result

Expected behavior:

- expired shard returns to `ready`
- replacement worker receives a new lease token
- replacement result can be accepted
- stale result is rejected
- final tested accounting still equals exactly `N`

### Gate F — Scaling benchmark

Run the identical frozen synthetic family at:

```
1, 2, 4, 8, 16, 32, 64 workers
```

Record at minimum:

- wall seconds
- candidate count
- effective candidates/sec
- total worker seconds if observable
- lease attempts
- expired/requeued leases
- duplicate attempted work
- duplicate accepted work (must be zero)
- coordination messages
- worker count
- WASM/kernel digest
- candidate-family digest

Compute:

```
speedup(p) = T1 / Tp
efficiency(p) = speedup(p) / p
```

The primary practical metric is wall-clock reduction. Aggregate-work efficiency is a separate research metric.

## 6. Acceptance Criteria for C95-AO-00

The synthetic distributed runner is certified only if all are true:

1. Exact interval coverage of `[0,N)`.
2. Zero accepted duplicate shard completions.
3. Family/kernel digest mismatch is rejected.
4. Plaintext-secret fields are rejected.
5. Synthetic known-answer commitment is recovered.
6. Aggregate accepted tested count equals exactly `N`.
7. Worker loss is recovered by expiry/requeue.
8. Stale lease result is rejected.
9. Repeated frozen runs produce deterministic result accounting.
10. At least one multi-worker AO run completes end-to-end.

Do not attach the live Arweave #3 oracle before these pass.

## 7. Next Live-Puzzle Integration After Certification

Current Lab C target lineage is Arweave Puzzle #3.

The latest bounded enriched family has mathematical size:

```
181,440
```

Prior certified/evaluated subsets:

```
SC-AR-01: 3,456
SC-AR-02: 4,608
union:    8,064
```

Novel Tier-2 remainder:

```
173,376
```

The current local runner already freezes the novel stream independently. The AO backend should eventually reproduce candidates **by deterministic index**, not transmit all candidate strings.

Before using AO against a live public puzzle:

- freeze exact candidate-generation version
- freeze family digest
- freeze WASM/kernel digest
- verify current target authorization/open status
- reproduce positive control
- preserve the local oracle as an independent verifier
- stop at a commitment if a hit occurs

## 8. Secret Hygiene — Non-Negotiable

Recovered live secret material must never enter:

- AO permanent messages
- HyperBEAM logs
- Git
- Google Drive
- research journal
- terminal transcript
- freeze package plaintext
- external APIs

For a live hit, return a commitment/reference only.

Lab C commitment convention:

```
C = SHA256("LAB-C-WIN-v1" || target-id || encode(secret))
```

The actual secret remains quarantined locally for human-controlled verification/claim handling.

## 9. Accounting Invariants

Search certificates describe mathematical coverage. The scoreboard counts unique actual oracle evaluations.

For distributed execution, require:

```
union(shard intervals) = [0,N)
intersection(shard_i, shard_j) = empty for accepted coverage, i != j
sum(accepted tested counts) = N
```

A re-run caused by an expired lease may consume compute, but it must not create duplicate **accepted coverage** or inflate unique-candidate accounting.

Keep separate:

- mathematical family size
- unique accepted candidate evaluations
- physical/retried candidate evaluations
- wall-clock time

## 10. Later: Adaptive Lensing Layer

Do not block the baseline distributed runner on this.

Once static distributed search is certified, evolve the coordinator from a shard allocator into a global-state controller:

```
G_t
 -> local projections/operators
 -> worker observations
 -> reducer
 -> G_(t+1)
 -> new projections/operators
 -> ...
```

The research question is whether local worker observations can cheaply change the remaining global search so later workers evaluate fewer or better candidates.

This is additive. Static deterministic sharding remains the fallback execution mode.

## 11. Definition of Done for This Handoff

The next engineer can consider the immediate build complete when:

```
synthetic family
  -> AO coordinator
  -> multiple AO workers
  -> real Rust/WASM execution
  -> exact reducer accounting
  -> known-answer commitment
  -> failure recovery
  -> measured scaling curve
```

At that point, freeze a C95-AO-00 report containing artifact hashes, worker configuration, scaling measurements, failure-injection results, and the exact code revision.

Then—and only then—attach a Lab C puzzle oracle.
