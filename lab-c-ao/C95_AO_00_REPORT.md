# C95-AO-00 Certification Report — Lab C AO Distributed Runner

**Status:** 
- **C95-AO-00A (Local/WASM Runner):** CERTIFIED & FROZEN
- **C95-AO-00B (Networked Distributed Runner):** CERTIFIED & FROZEN
- **C95-AO-00C (Native AO/HyperBEAM Platform):** READY FOR EXECUTION
**Repository:** `k-luecke/paxiom`  
**Branch:** `lab-c-ao-runner`  
**Execution Environment:** WSL2 (Ubuntu 24.04 Linux, x86_64), Node v18.19.1, Rustc 1.94.1  
**Scope:** Intentionally published cryptographic puzzles / synthetic search kernels only  

---

## 1. Executive Summary & Three-Layer Milestone Architecture

To prevent architectural ambiguity between local process simulation, distributed networking, and live on-chain AO deployment, the Lab C AO runner certification is structured into three distinct, verifiable milestones:

$$\boxed{\text{C95-AO-00A: Local / WASM Runner}} \longrightarrow \boxed{\text{C95-AO-00B: Networked Distributed Runner}} \longrightarrow \boxed{\text{C95-AO-00C: Native AO / HyperBEAM}}$$

1. **C95-AO-00A (Certified):** Verifies the standalone Rust/WASM search kernel, C ABI compatibility, bit-identical native/WASM execution equivalence, deterministic shard leases, secret quarantine, and host initialization bottleneck characterization.
2. **C95-AO-00B (Certified):** Establishes an asynchronous, networked distributed runner operating across independent OS daemon processes communicating over an HTTP transport router with unique Process IDs and cryptographic message IDs (`msg-xxxx`). Solves the host compute/transport asymmetry by calibrating an expensive synthetic oracle ($r^* = 200,000$ SHA-512 rounds, $\approx 160\text{ ms/candidate}$) matching Arweave Puzzle #3 oracle cost. Proves mid-lease fault tolerance, stale submission rejection, empirical scaling across $p \in \{1, 2, 4, 8\}$ workers, and zero duplicate accepted work under sustained multi-worker soak.
3. **C95-AO-00C (Next Milestone):** Bridges the certified coordination state machine (`coordinator.lua`) and worker harness directly into genuine AO processes / HyperBEAM compute units on the live AO network or local Erlang BEAM runtime.

---

## 2. Frozen Release Artifact Checksums

All core binaries, source modules, and transport daemons are cryptographically locked:

| Component | Path | SHA-256 Checksum |
| :--- | :--- | :--- |
| **WASM Kernel (Calibrated Release)** | `lab-c-ao/lab_c_ao_worker.wasm` | `73ec9947271d2e7b5da6ed134d119c379708a888b5f80996b6e3a7e44a696d9d` |
| **AO Coordinator Contract** | `lab-c-ao/coordinator.lua` | `135f3ac40055e7be4c6a629a972a98ce37544550ec451a82b33050f14e753ad2` |
| **AO Worker Contract** | `lab-c-ao/worker.lua` | `47ba9a879e6c5a8d30adc483a57b00d4ca9532ed9cbff399d301aad1f6c10c41` |
| **Reference WASM Host Runner** | `lab-c-ao/wasm_runner.mjs` | `d59cc435ebe5ee3f7e345956b84b01e652f571552288d53a25a125c4772b4152` |
| **Network Transport Router** | `lab-c-ao/transport/network_router.mjs` | `16d6f96970f9a8aade50962ca1f8aca76d30c3ac4cc484a99e5cada9d9dfda52` |
| **Coordinator Daemon** | `lab-c-ao/transport/coordinator_daemon.mjs` | `985da492db9b9ff858fa89a29aaef05d3c0235d93188563bb0c00575691b8825` |
| **Worker Daemon** | `lab-c-ao/transport/worker_daemon.mjs` | `7ac9302ae0e4265b07400776b333a619bc881773b0827b4e734d07f8ac992081` |

---

## 3. Architecture & Execution Seams

### 3.1 Network Topology (C95-AO-00B)

```
                       +------------------------------------------+
                       | HTTP Message Router (network_router.mjs) |
                       | - Non-blocking inboxes & long-polling    |
                       | - Process addressing (PID)               |
                       | - Message IDs (msg-xxxx) & Audit Log     |
                       +------------------------------------------+
                                    ^          ^          ^
                 +------------------+          |          +------------------+
                 | HTTP /send & /poll          |                             |
                 v                             v                             v
+-------------------------------+ +------------------------+   +------------------------+
| Coordinator Daemon            | | Worker Daemon 1        |   | Worker Daemon p        |
| (coordinator_daemon.mjs)      | | (worker_daemon.mjs)    |   | (worker_daemon.mjs)    |
| - Deterministic half-open     | | - Process ID: worker-1 |   | - Process ID: worker-p |
|   interval sharding           | | - Local WASM Runner    |   | - Local WASM Runner    |
| - Lease expiry & requeuing    | | - Secret Quarantine    |   | - Secret Quarantine    |
| - Strict ledger accounting    | | - Retries & Backoff    |   | - Retries & Backoff    |
+-------------------------------+ +------------------------+   +------------------------+
                                               |                             |
                                               v                             v
                                  +------------------------+   +------------------------+
                                  | lab_c_ao_worker.wasm   |   | lab_c_ao_worker.wasm   |
                                  | - r* = 200,000 rounds  |   | - r* = 200,000 rounds  |
                                  | - ~160ms / candidate   |   | - ~160ms / candidate   |
                                  +------------------------+   +------------------------+
```

### 3.2 WASM C ABI Specification
The kernel exports a minimal C-compatible ABI with fixed layout memory buffers:
- `alloc_bytes(len: usize) -> *mut u8`: linear memory allocator for input strings (`run_id`).
- `free_bytes(ptr: *mut u8, len: usize)`: linear memory deallocator.
- `run_shard_abi(start, end, known, run_id_ptr, len) -> *const ShardOutputAbi`: baseline synthetic kernel.
- `run_shard_calibrated_abi(start, end, known, work_rounds, run_id_ptr, len) -> *const ShardOutputAbi`: calibrated expensive synthetic oracle.
- `ShardOutputAbi` (88 bytes, 8-byte aligned):
  - `offset 0..8`: `tested` (`u64`)
  - `offset 8..9`: `has_hit` (`u8`)
  - `offset 9..16`: `_pad` (`[u8; 7]`)
  - `offset 16..24`: `hit_index` (`u64`, internal test harness use only)
  - `offset 24..56`: `hit_commitment` (`[u8; 32]`)
  - `offset 56..88`: `result_digest` (`[u8; 32]`)

Per protocol quarantine requirements, `hit_index` is omitted from `SubmitShard` envelopes; only the 32-byte cryptographic hit commitment is submitted through the network router.

---

## 4. Milestone C95-AO-00A: Local/WASM Runner Certification

### 4.1 Rust Search Kernel & Native Equivalence
- The search kernel was compiled from `lab-c-ao/rust-worker/src/lib.rs` to `wasm32-unknown-unknown`.
- Bit-identical native vs WASM equivalence was certified across test suites:
  - Unit tests and ABI roundtrip tests: 4 passed in 0.00s.
  - Known-answer hit recovery: Single-worker known-answer run at $N = 4,608$ candidates ($Z = 1,024$, known index $3,137$) recovered hit commitment `63b7066fb34ca2a767783655b0450a58b92e77e780315a07c2127c5cde33823b` identically across native and WASM engines.

### 4.2 Host Bottleneck Characterization
Initial uncalibrated scaling experiments evaluated $N = 181,440$ candidates across 1 to 64 local threads.
- Raw Rust/WASM execution time for all 181,440 candidates: **41.9 milliseconds** (~$4.33 \times 10^6\text{ candidates/sec}$).
- Spawning 32 to 64 local worker threads consumed **7.8 to 8.2 seconds** purely in V8 isolate startup and OS thread creation—over $180\times$ longer than the compute itself.
- **Critical Architectural Sizing Rule:** Distributed workers in AO/HyperBEAM are long-running stateful nodes. To prevent transport and startup overhead from dominating wall-clock execution, shard sizes must be calibrated such that:

$$T_{\text{compute / shard}} \gg T_{\text{transport}} + T_{\text{startup}} \quad (\ge 2\text{ to }10\text{ seconds/shard})$$

---

## 5. Milestone C95-AO-00B: Networked Distributed WASM Runner Certification

### 5.1 Oracle Calibration ($r^*$)
The synthetic oracle was calibrated in `lab-c-ao/calibrate_oracle.mjs` against the cost of the live Arweave Puzzle #3 cryptographic oracle:
- Live Arweave #3 candidate evaluation throughput: $\approx 6.2\text{ candidates/second}$ ($\approx 161.3\text{ ms/candidate}$).
- Calibrated WASM iterated SHA-512 rounds: $r^* = 200,000$ rounds.
- Empirical WASM evaluation rate: **$160.01\text{ ms/candidate}$** ($6.25\text{ candidates/sec}$).
- Production shard size: $Z = 16$ candidates $\implies \mathbf{2.56\text{ seconds}}$ of pure WASM computation per shard.

### 5.2 Network Transport & Fault Injection Verification
Test 1 of `test_networked_distributed.mjs` verified mid-lease node loss, lease expiration, and stale submission rejection over HTTP:
1. **Lease Acquisition:** Worker 1 (`worker-fault-01`) acquired lease on Shard 1 with lease token `fault-injection-run:1:1:1790969152345`.
2. **Forced Node Crash:** Worker 1 process was abruptly terminated (`kill -9`) mid-computation.
3. **Automatic Expiry & Requeuing:** Coordinator elapsed past `lease_ms = 4000ms`, returned Shard 1 to `ready`, and incremented the attempt counter to 2.
4. **Re-Leasing:** Worker 2 (`worker-fault-02`) requested work and leased Shard 1 with new token `fault-injection-run:1:2:1790969156867`.
5. **Stale Submission Rejection:** Stale Worker 1 attempted submission using expired token 1. The coordinator rejected it immediately: `{"error":"lease owner mismatch"}` and incremented `rejected_stale_or_duplicate`.
6. **Valid Completion:** Worker 2 completed and submitted Shard 1; accepted by coordinator.

### 5.3 Scaling Benchmark Results ($p \in \{1, 2, 4, 8\}$)
Test 2 executed the calibrated search across $N = 128$ candidates ($8$ shards of $Z = 16$ candidates, total pure compute $\approx 20.5\text{ seconds}$):

| Workers ($p$) | Wall Time ($T_p$) | Throughput | Speedup ($S_p = T_1 / T_p$) | Efficiency ($\eta_p = S_p / p$) | Duplicate Work | Rejected Stale | Hits Recovered |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **1** | 21.940 s | 5.83 c/s | 1.000x | 1.000 | 0 | 0 | 1 |
| **2** | 13.878 s | 9.22 c/s | 1.581x | 0.790 | 0 | 0 | 1 |
| **4** | 12.620 s | 10.14 c/s | 1.739x | 0.435 | 0 | 0 | 1 |
| **8** | 11.263 s | 11.36 c/s | 1.948x | 0.243 | 0 | 0 | 1 |

*Raw data persisted in `lab-c-ao/c95_ao_00b_scaling_results.json`.*

### 5.4 Search Time Projection for Novel Candidate Space
For the target novel candidate family ($N = 173,376$ candidates), the total wall-clock search time is projected using the empirical throughput $\text{Throughput}(p) = p \cdot r_1 \cdot \eta(p)$:

$$T_{\text{search}}(p) = \frac{N}{\text{Throughput}(p)}$$

$$\begin{aligned}
p = 1: & \quad \frac{173,376}{5.833\text{ c/s}} \approx 29,723\text{ s} \approx \mathbf{8.26\text{ hours}} \\
p = 2: & \quad \frac{173,376}{9.223\text{ c/s}} \approx 18,798\text{ s} \approx \mathbf{5.22\text{ hours}} \\
p = 4: & \quad \frac{173,376}{10.140\text{ c/s}} \approx 17,098\text{ s} \approx \mathbf{4.75\text{ hours}} \\
p = 8: & \quad \frac{173,376}{11.365\text{ c/s}} \approx 15,255\text{ s} \approx \mathbf{4.24\text{ hours}}
\end{aligned}$$

### 5.5 Sustained Multi-Worker Soak Test
Test 3 executed 8 concurrent worker daemons continuously searching a 256-candidate space ($16$ shards):
- **Wall Time:** 16.78 seconds.
- **Tested Count:** Exactly 256 candidates ($100\%$ mathematical coverage).
- **Hits Recovered:** 1 hit commitment.
- **Stale Rejections:** 0.
- **Memory/Socket Leaks:** 0.

---

## 6. Accounting Ledger Invariants

The coordinator state strictly enforces the core distributed accounting invariants:

$$\bigcup_{i=1}^m [\text{start}_i, \text{end}_i) = [0, N)$$
$$[\text{start}_i, \text{end}_i) \cap [\text{start}_j, \text{end}_j) = \emptyset \quad \forall i \neq j \text{ in accepted completions}$$
$$\sum_{i=1}^m (\text{end}_i - \text{start}_i) = N$$

| Accounting Metric | Definition | Fault Test (00B) | Benchmark $p=8$ (00B) | Soak Test (00B) |
| :--- | :--- | :---: | :---: | :---: |
| `mathematical_candidates` | Target search space size ($N$) | 32 | 128 | 256 |
| `unique_accepted_evaluations` | Unique verified candidate evaluations | 32 | 128 | 256 |
| `physical_evaluations` | Total evaluations attempted across all leases | 48 | 128 | 256 |
| `accepted_completions` | Completed shard count ($m$) | 2 | 8 | 16 |
| `rejected_stale_or_duplicate` | Stale or duplicate submission attempts | 1 | 0 | 0 |
| `expired_leases` | Shards returned to ready on lease timeout | 1 | 0 | 0 |
| `duplicate_accepted_work` | Overlapping evaluations accepted into reducer | **0** | **0** | **0** |

---

## 7. Secret Quarantine Verification

Negative adversarial testing verified secret quarantine at every layer:
1. **Worker Process Firewall:** `worker_daemon.mjs` scans all WASM outputs before network transmission; presence of `secret`, `private_key`, `seed`, or `mnemonic` throws a quarantine breach exception.
2. **Coordinator Firewall:** `coordinator_daemon.mjs` and `coordinator.lua` inspect inbound JSON payloads; any payload containing secret keys is rejected with `plaintext secret rejected`.
3. **Commitment Submission:** Positive hits submit only $C = \text{SHA256}(\text{"LAB-C-WIN-v1"} \parallel \text{run\_id} \parallel \text{candidate})$. No plaintext private key, mnemonic, or seed is ever transmitted over the network router or committed to logs.

---

## 8. Milestone C95-AO-00C (Native AO / HyperBEAM) Roadmap

With milestones **00A** (Local/WASM) and **00B** (Networked Distributed Runner) certified and locked, the platform execution boundary is fully prepared for **C95-AO-00C**:

1. **Native HyperBEAM Node Bringup:** Recompile `rebar3` compatible with local Erlang/OTP 25 (`13.2.2.5`) to boot local HyperBEAM nodes for offline consensus testing.
2. **Live AOS Process Deployment:** Deploy `coordinator.lua` and `worker.lua` onto the AO testnet using `@permaweb/aoconnect`.
3. **Production Shard Dispatch:** Attach the bounded Tier-2 Arweave Puzzle #3 candidate space ($N = 173,376$) with shard size $Z \ge 16$ candidates, executing distributed search with guaranteed secret quarantine and exact accounting.
