# C95-AO-00 Certification Report — Lab C AO Distributed Runner

**Status:** CERTIFIED  
**Repository:** `k-luecke/paxiom`  
**Branch:** `lab-c-ao-runner`  
**Execution Environment:** WSL2 (Ubuntu Linux, x86_64), Node v18.19.1, Rustc 1.94.1  
**Scope:** Intentionally published cryptographic puzzles / synthetic search kernels only  

---

## 1. Executive Summary

This report certifies the completion and verification of the **Lab C AO Distributed Runner** milestone (`C95-AO-00`). The prototype coordination layer in `lab-c-ao/` has been integrated with a real WebAssembly execution bridge, executing the compiled Rust synthetic search kernel (`lab_c_ao_worker.wasm`) end-to-end through AO message dispatch.

All 10 acceptance criteria defined in the engineering handoff have passed without exception:
1. **Exact interval coverage:** All partitions form a complete partition of $[0, N)$ with zero gaps and zero overlaps.
2. **Zero accepted duplicate completions:** Every shard is accepted at most once into the final reducer state.
3. **Digest mismatch rejection:** Both `family_digest` and `kernel_digest` mismatches cause immediate rejection (`LabCError`).
4. **Plaintext secret rejection:** Any payload containing `secret`, `private_key`, `seed`, or `mnemonic` is rejected by both worker transport and coordinator.
5. **Synthetic known-answer recovery:** The exact hit commitment $C = \text{SHA256}(\text{"LAB-C-WIN-v1"} \parallel \text{run\_id} \parallel \text{candidate})$ was recovered across single-worker and multi-worker runs.
6. **Aggregate accounting:** Sum of unique accepted tested counts strictly equals $N$.
7. **Worker loss recovery:** Leased shards held past `lease_ms` are safely requeued to `ready` state with incremented attempt counters.
8. **Stale lease rejection:** Workers waking after their lease expired are rejected when submitting against stale tokens.
9. **Determinism:** Repeated frozen runs yield bit-identical result digests and accounting summaries.
10. **Genuine multi-worker AO execution:** Verified with multiple concurrent AO worker processes participating and completing end-to-end.

---

## 2. Frozen Artifact Hashes

The final release build of the Rust search kernel was compiled to `wasm32-unknown-unknown` with `opt-level = 3`, `lto = true`, and `strip = true`. Any modification to source or build flags invalidates `kernel_digest` and requires rebuilding and re-freezing.

| Artifact | Path | SHA-256 Checksum |
| :--- | :--- | :--- |
| **WASM Kernel** | `lab-c-ao/lab_c_ao_worker.wasm` | `14abbf8a03d47308232faccc351635699ef1653e4cfe16c91714677d5b10d62c` |
| **Coordinator Process** | `lab-c-ao/coordinator.lua` | `135f3ac40055e7be4c6a629a972a98ce37544550ec451a82b33050f14e753ad2` |
| **Worker Process** | `lab-c-ao/worker.lua` | `47ba9a879e6c5a8d30adc483a57b00d4ca9532ed9cbff399d301aad1f6c10c41` |
| **Reference WASM Runner** | `lab-c-ao/wasm_runner.mjs` | `4b2a887fc17794c6e2f81f4ddc2c0ab9baa09e0f1ea4fe52be36d979bcac569b` |

---

## 3. Architecture & Execution Seam

The coordination and execution flow maintains strict isolation between transport metadata and search kernel execution:

```
[AO Coordinator (coordinator.lua)]
        |
        | ShardLease (run_id, shard_id, lease_token, [start, end), digests)
        v
[AO Worker (worker.lua)]
        |
        | Digest validation & secret quarantine
        v
[WASM Bridge (wasm_runner.mjs / ABI)]
        |
        | run_shard_abi(start, end, known_index, run_id_ptr, len)
        v
[Rust WASM Kernel (lab_c_ao_worker.wasm)]
        |
        | ShardOutputAbi (tested, result_digest, has_hit, hit_commitment)
        v
[AO Worker (worker.lua)]
        |
        | SubmitShard (tested, result_digest, hit_commitment)
        v
[AO Coordinator / Reducer (coordinator.lua)]
```

### WASM C ABI Specification
The kernel exports a minimal C-compatible ABI with fixed layout memory buffers:
- `alloc_bytes(len: usize) -> *mut u8`: linear memory allocator for input strings (`run_id`).
- `free_bytes(ptr: *mut u8, len: usize)`: linear memory deallocator.
- `run_shard_abi(start: u64, end: u64, known: u64, run_id_ptr: *const u8, len: usize) -> *const ShardOutputAbi`: executes half-open interval `[start, end)`.
- `ShardOutputAbi` (88 bytes, 8-byte aligned):
  - `offset 0..8`: `tested` (`u64`)
  - `offset 8..9`: `has_hit` (`u8`)
  - `offset 9..16`: `_pad` (`[u8; 7]`)
  - `offset 16..24`: `hit_index` (`u64`, internal/synthetic harness use only)
  - `offset 24..56`: `hit_commitment` (`[u8; 32]`)
  - `offset 56..88`: `result_digest` (`[u8; 32]`)

Per protocol requirements, `hit_index` is omitted from `SubmitShard` envelopes; only the 32-byte cryptographic hit commitment is submitted through AO.

---

## 4. Gate Verification Records

### Gate A & B — Build to WASM & ABI Definition
- Target `wasm32-unknown-unknown` built clean with zero compiler warnings.
- Artifact SHA-256 frozen as `14abbf8a03d47308232faccc351635699ef1653e4cfe16c91714677d5b10d62c`.
- Native Rust unit tests and WASM ABI roundtrip tests: 4 passed in 0.00s.

### Gate C — AO Worker Connection
- `worker.lua` updated with dual execution paths:
  1. Direct host runner invocation via `wasm_runner.mjs`.
  2. Asynchronous AO message seam: `ShardLease` -> `ExecuteWasmShard` -> `WasmShardResult` -> `SubmitShard`.
- Both paths enforce quarantine against plaintext secret leaks.

### Gate D — Single-Worker Known-Answer Run
- Run parameters: $N = 4,608$ candidates, shard size $Z = 1,024$, known index $= 3,137$.
- Shard count: 5 shards.
- Tested candidate count: exactly $4,608$.
- Expected hit commitment recovered:
  `63b7066fb34ca2a767783655b0450a58b92e77e780315a07c2127c5cde33823b`
  (matches $\text{SHA256}(\text{"LAB-C-WIN-v1"} \parallel \text{run\_id} \parallel \text{index.to\_be\_bytes()})$).
- Result digest determinism: bit-identical across consecutive runs.
- Duplicate accepted completions: 0.

### Gate E — Failure Injection & Stale Worker Rejection
- Tested fault sequence:
  1. Worker A leases Shard 1 ($[0, 1024)$) at $t=1000$ with `lease_token_A`.
  2. Worker A computes shard but delays submission.
  3. Coordinator clock advances past $t=10000$ (`lease_ms`).
  4. Shard 1 expires and returns to `ready`; attempt counter increments.
  5. Worker B leases Shard 1 at $t=12500$ with `lease_token_B` ($\neq \text{token}_A$).
  6. Worker A submits with `lease_token_A` at $t=13000$ $\rightarrow$ **REJECTED** (`stale lease token`, error logged, rejection counter incremented).
  7. Worker B submits valid Shard 1 result $\rightarrow$ **ACCEPTED**.
  8. Worker B completes Shard 2.
- Accounting reconciliation:
  - Mathematical candidates: $2,048$.
  - Unique accepted evaluations: $2,048$.
  - Physical evaluations dispatched: $3,072$ ($1,024 \times 3$ attempts).
  - Accepted shard completions: $2$.
  - Rejected stale submissions: $1$.

---

## 5. Multi-Worker Execution & Scaling Benchmarks

Per engineering amendments, results are separated into two distinct categories:
1. `GENUINE_MULTIWORKER_AO_EXECUTION`: An actual multi-process AO execution where multiple distinct AO worker processes concurrently lease and complete shards over the AO message protocol.
2. `LOCAL_DISTRIBUTED_BASELINE`: A local machine scaling benchmark across 1 to 64 workers measuring speedup, efficiency, and host bottlenecking.

### 5.1 Genuine Multi-Worker AO Execution
- Execution file: `lab-c-ao/tests/test_multiworker_ao.py`
- Configuration: 4 concurrent AO worker processes (`ao-worker-proc-1` through `ao-worker-proc-4`), 1 AO coordinator process.
- Candidate family: $N = 4,608$, shard size $= 1,024$, 5 shards.
- Results:
  - Participating workers: 4 / 4 concurrent workers successfully leased and completed shards.
  - Wall-clock time: **0.624 seconds**.
  - Mathematical candidates covered: $4,608$.
  - Unique accepted candidate evaluations: $4,608$.
  - Physical candidate evaluations: $4,608$.
  - Duplicate accepted completions: **0**.
  - Hit commitment recovered: `63b7066fb34ca2a767783655b0450a58b92e77e780315a07c2127c5cde33823b`.
  - Coordinator status: `complete = true`.

### 5.2 LOCAL_DISTRIBUTED_BASELINE (Scaling Curve: 1 to 64 Workers)
- Candidate family: $N = 181,440$ candidates (identical mathematical size to Arweave #3 Tier-2 candidate family), shard size $Z = 4,096$ (45 shards total).
- Raw Rust/WASM computation time for all 181,440 candidates: **41.9 milliseconds** (~4,329,000 candidates/sec intrinsic WASM throughput).

#### Threaded In-Memory WASM Execution Series
| Workers ($p$) | Wall Time ($T_p$) | Worker Time | Coord Overhead | Throughput | Speedup ($S_p$) | Efficiency ($E_p$) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **1** | 0.1879s | 0.0419s | 0.1460s | 965,676 c/s | 1.00x | 1.00 |
| **2** | 0.1880s | 0.0392s | 0.1684s | 964,975 c/s | 1.00x | 0.50 |
| **4** | 0.2834s | 0.0465s | 0.2718s | 640,130 c/s | 0.66x | 0.17 |
| **8** | 0.4534s | 0.0453s | 0.4477s | 400,210 c/s | 0.41x | 0.05 |
| **16** | 0.8853s | 0.1477s | 0.8761s | 204,940 c/s | 0.21x | 0.01 |
| **32** | 7.9032s | 1.3613s | 7.8606s | 22,958 c/s | 0.02x | 0.00 |
| **64** | 8.2558s | 3.0416s | 8.2082s | 21,977 c/s | 0.02x | 0.00 |

#### Host Bottleneck Analysis
The empirical measurements demonstrate an important operational finding regarding host resource allocation:
1. **Compute vs. Setup Asymmetry:** Because the optimized Rust/WASM kernel evaluates 181,440 synthetic candidates in only **42 milliseconds**, the workload is compute-light.
2. **Shard Exhaustion:** At $N = 181,440$ with $Z = 4,096$, there are only 45 shards. When $p = 64$, 19 worker instances never receive work.
3. **Thread/Isolate Initialization Bottleneck:** Spawning 32 to 64 V8 worker threads consumes between 7.8s and 8.2s of thread initialization and OS context switching—nearly $200\times$ more time than the actual search computation.
4. **Architectural Implication for Production AO:** In a distributed network like AO/HyperBEAM, workers are long-running stateful processes. To amortize message round-trip time (RTT) and coordination overhead, production shard sizes for cryptographic puzzles should be sized to require $\ge 2$–$10$ seconds of continuous compute per shard (e.g., $10^7$ to $10^8$ candidates per shard).

---

## 6. Accounting Ledger Invariants

The coordinator state strictly preserves the separation between mathematical coverage, physical evaluations, and accepted submissions:

$$\bigcup_{i=1}^m [\text{start}_i, \text{end}_i) = [0, N)$$
$$[\text{start}_i, \text{end}_i) \cap [\text{start}_j, \text{end}_j) = \emptyset \quad \forall i \neq j \text{ in accepted completions}$$
$$\sum_{i=1}^m (\text{end}_i - \text{start}_i) = N$$

| Counter | Definition | Synthetic Gate D | Failure Injection Gate E | Genuine Multi-Worker AO |
| :--- | :--- | :---: | :---: | :---: |
| `mathematical_candidates` | Intended mathematical interval size | 4,608 | 2,048 | 4,608 |
| `unique_accepted_evaluations` | Unique verified candidate evaluations | 4,608 | 2,048 | 4,608 |
| `physical_evaluations` | Total evaluations attempted across all leases | 4,608 | 3,072 | 4,608 |
| `accepted_completions` | Total accepted completed shards | 5 | 2 | 5 |
| `rejected_stale_or_duplicate` | Stale or duplicate submission attempts | 0 | 1 | 0 |
| `expired_leases` | Shards returned to ready on lease timeout | 0 | 1 | 0 |

---

## 7. Secret Quarantine Verification

Quarantine enforcement was verified through negative adversarial testing:
- **Test case:** Worker payloads deliberately injected with `secret`, `private_key`, `seed`, and `mnemonic` fields.
- **Result:** Coordinator rejected every payload immediately with error `plaintext secret rejected`.
- **Worker transport firewall:** `worker.lua` validates results before forwarding; any secret material halts message submission.
- **Commitment verification:** A positive hit produces only the deterministic commitment $C = \text{SHA256}(\text{"LAB-C-WIN-v1"} \parallel \text{run\_id} \parallel \text{candidate})$. No candidate or secret plaintext is transmitted across the AO bus.

---

## 8. Certification Sign-off

The Lab C AO Distributed Runner is certified for milestone `C95-AO-00`. The coordination layer, WASM compilation pipeline, reference host runner, failure injection defenses, and accounting invariants are verified and frozen.

The system is ready for the next scheduled milestone: attaching the live puzzle oracle (Arweave Puzzle #3 Tier-2 bounded family) following strict authorization and secret quarantine protocols.
