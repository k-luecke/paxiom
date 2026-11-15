"""
Genuine Multi-Worker AO Execution Verification for C95-AO-00 Certification.

Deploys:
- 1 AO Coordinator instance executing coordinator.lua logic
- Multiple distinct AO Worker instances executing worker.lua logic
- Real compiled lab_c_ao_worker.wasm execution via wasm_runner.mjs
- Verifies concurrent multi-worker completion, accounting invariants,
  and hit commitment recovery.
"""

import concurrent.futures
import hashlib
import json
import os
import sys
import time

from harness import (
    AoCoordinator,
    AoWorker,
    AoMessage,
    WASM_BINARY_PATH,
    invoke_wasm_shard,
)


def compute_kernel_digest() -> str:
    with open(WASM_BINARY_PATH, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


KERNEL_DIGEST = compute_kernel_digest()
FAMILY_DIGEST = hashlib.sha256(b"LAB-C-AO-GENUINE-MULTIWORKER-v1|N=4608").hexdigest()


def test_genuine_multiworker_ao_run():
    print("=" * 80)
    print("C95-AO-00 — GENUINE MULTI-WORKER AO EXECUTION TEST")
    print("=" * 80)

    N = 4608
    SHARD_SIZE = 1024
    KNOWN_INDEX = 3137
    RUN_ID = "genuine-ao-multiworker-run"
    WORKER_COUNT = 4

    coord = AoCoordinator("coord-ao-main")

    # 1. Initialize Run on Coordinator
    create_msg = AoMessage(
        sender="deployer",
        target=coord.id,
        action="CreateRun",
        data={
            "run_id": RUN_ID,
            "target_id": "arweave-puzzle-3-synthetic",
            "candidate_count": N,
            "shard_size": SHARD_SIZE,
            "family_digest": FAMILY_DIGEST,
            "kernel_digest": KERNEL_DIGEST,
            "lease_ms": 60000,
        },
        timestamp_ms=int(time.time() * 1000),
    )
    init_res = coord.receive_message(create_msg)
    assert init_res.action == "RunCreated"
    assert init_res.data["candidate_count"] == N
    assert init_res.data["shard_count"] == 5

    # 2. Instantiate 4 distinct AO Worker processes
    workers = [
        AoWorker(
            worker_id=f"ao-worker-proc-{i+1}",
            coordinator=coord,
            family_digest=FAMILY_DIGEST,
            kernel_digest=KERNEL_DIGEST,
            known_index=KNOWN_INDEX,
        )
        for i in range(WORKER_COUNT)
    ]

    print(f"Spawned {len(workers)} distinct AO workers connected to coordinator {coord.id}")

    # Track worker activity
    worker_shards_completed = {w.id: 0 for w in workers}
    accepted_intervals = []

    def worker_process_thread(worker: AoWorker):
        completed = 0
        while True:
            # AO Worker receives/sends message to coordinator
            now_ms = int(time.time() * 1000)
            lease_msg = AoMessage(
                sender=worker.id,
                target=coord.id,
                action="LeaseShard",
                data={"run_id": RUN_ID},
                timestamp_ms=now_ms,
            )
            lease_resp = coord.receive_message(lease_msg)
            if not lease_resp or lease_resp.action != "ShardLease":
                break

            shard_data = lease_resp.data
            sid = shard_data["shard_id"]
            start_idx = shard_data["start_index"]
            end_idx = shard_data["end_index"]
            token = shard_data["lease_token"]

            # Real WASM execution
            wasm_res, duration = invoke_wasm_shard(
                start=start_idx,
                end=end_idx,
                known_index=KNOWN_INDEX,
                run_id=RUN_ID,
                wasm_path=WASM_BINARY_PATH,
            )

            # Quarantine assertion
            for forbidden in ["secret", "private_key", "seed", "mnemonic"]:
                assert forbidden not in wasm_res, f"Quarantine breach: {forbidden} present!"

            # AO Worker submits result envelope
            submit_data = {
                "run_id": RUN_ID,
                "shard_id": sid,
                "lease_token": token,
                "family_digest": FAMILY_DIGEST,
                "kernel_digest": KERNEL_DIGEST,
                "tested": wasm_res["tested"],
                "result_digest": wasm_res["result_digest"],
                "hit_commitment": wasm_res.get("hit_commitment"),
            }
            submit_msg = AoMessage(
                sender=worker.id,
                target=coord.id,
                action="SubmitShard",
                data=submit_data,
                timestamp_ms=int(time.time() * 1000),
            )
            accept_resp = coord.receive_message(submit_msg)
            assert accept_resp.action == "ShardAccepted"

            accepted_intervals.append((start_idx, end_idx))
            completed += 1
            print(f"  [{worker.id}] completed shard {sid}: [{start_idx}, {end_idx}) in {duration*1000:.1f}ms")

        worker_shards_completed[worker.id] = completed

    t_start = time.perf_counter()
    with concurrent.futures.ThreadPoolExecutor(max_workers=WORKER_COUNT) as executor:
        futures = [executor.submit(worker_process_thread, w) for w in workers]
        concurrent.futures.wait(futures)
    wall_duration = time.perf_counter() - t_start

    # Final verification of coordinator run state
    final_state = coord.summarize(coord.runs[RUN_ID])
    print(f"\nFinal Coordinator State:\n{json.dumps(final_state, indent=2)}")

    # 1. Exact interval coverage of [0, N)
    accepted_intervals.sort(key=lambda x: x[0])
    assert accepted_intervals[0][0] == 0, "Coverage does not start at 0"
    assert accepted_intervals[-1][1] == N, f"Coverage does not end at {N}"
    for i in range(len(accepted_intervals) - 1):
        assert accepted_intervals[i][1] == accepted_intervals[i+1][0], "Interval gap or overlap detected"

    # 2. Zero accepted duplicate shard completions
    assert final_state["rejected_stale_or_duplicate"] == 0
    assert final_state["done"] == 5

    # 3. Sum of accepted tested counts equals N
    assert final_state["unique_accepted_evaluations"] == N
    assert final_state["tested"] == N

    # 4. Recovered synthetic known-answer commitment
    assert final_state["hit_count"] == 1
    candidate_bytes = KNOWN_INDEX.to_bytes(8, "big")
    expected_commitment = hashlib.sha256(b"LAB-C-WIN-v1" + RUN_ID.encode("utf8") + candidate_bytes).hexdigest()
    assert final_state["hits"][0]["hit_commitment"] == expected_commitment
    assert final_state["complete"] is True

    # 5. Multiple workers participated
    participating_workers = sum(1 for count in worker_shards_completed.values() if count > 0)
    assert participating_workers > 1, f"Expected multiple participating workers, got {participating_workers}"

    print(f"\nSUCCESS: Genuine multi-worker AO execution verified with {participating_workers} participating workers in {wall_duration:.3f}s.")
    return final_state


if __name__ == "__main__":
    test_genuine_multiworker_ao_run()
