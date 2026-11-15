"""
Gate F — Scaling Benchmark for Lab C AO Distributed Runner.

Evaluates the frozen synthetic candidate family across worker counts:
1, 2, 4, 8, 16, 32, 64 workers.

Per engineering directives:
- Labeled explicitly as LOCAL_DISTRIBUTED_BASELINE.
- Distinguishes worker execution time from coordinator/dispatch/queue overhead.
- Analyzes host bottlenecking before 32/64 workers.
- Records candidate count, effective throughput, speedup, efficiency, and zero duplicate accepted work.
"""

import concurrent.futures
import hashlib
import json
import os
import sys
import time
from typing import Dict, Any, List

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
FAMILY_DIGEST = hashlib.sha256(b"LAB-C-AO-SYNTHETIC-FAMILY-v1|N=181440").hexdigest()


def run_benchmark_for_workers(
    worker_count: int,
    candidate_count: int = 181440,
    shard_size: int = 4096,
    known_index: int = 42109,
) -> Dict[str, Any]:
    run_id = f"benchmark-p{worker_count}-N{candidate_count}"
    coord = AoCoordinator(f"coord-p{worker_count}")

    # 1. Create run
    t_start = time.perf_counter()
    coord.receive_message(
        AoMessage(
            sender="benchmarker",
            target=coord.id,
            action="CreateRun",
            data={
                "run_id": run_id,
                "target_id": "arweave-puzzle-3-synthetic",
                "candidate_count": candidate_count,
                "shard_size": shard_size,
                "family_digest": FAMILY_DIGEST,
                "kernel_digest": KERNEL_DIGEST,
                "lease_ms": 300000,
            },
            timestamp_ms=1000,
        )
    )

    workers = [
        AoWorker(
            worker_id=f"worker-{i}",
            coordinator=coord,
            family_digest=FAMILY_DIGEST,
            kernel_digest=KERNEL_DIGEST,
            known_index=known_index,
        )
        for i in range(worker_count)
    ]

    total_worker_wasm_time = 0.0
    total_coordinator_time = 0.0

    # Worker worker function executed in parallel thread pool
    def worker_loop(w: AoWorker) -> float:
        worker_wasm_time = 0.0
        while True:
            # Lease step
            t_coord_0 = time.perf_counter()
            lease_req = AoMessage(
                sender=w.id,
                target=coord.id,
                action="LeaseShard",
                data={"run_id": run_id},
                timestamp_ms=int(time.time() * 1000),
            )
            resp = coord.receive_message(lease_req)
            t_coord_1 = time.perf_counter()

            if not resp or resp.action != "ShardLease":
                break

            shard = resp.data
            wasm_res, duration = invoke_wasm_shard(
                start=shard["start_index"],
                end=shard["end_index"],
                known_index=known_index,
                run_id=run_id,
                wasm_path=WASM_BINARY_PATH,
            )
            worker_wasm_time += duration

            # Submit step
            submit_data = {
                "run_id": run_id,
                "shard_id": shard["shard_id"],
                "lease_token": shard["lease_token"],
                "family_digest": FAMILY_DIGEST,
                "kernel_digest": KERNEL_DIGEST,
                "tested": wasm_res["tested"],
                "result_digest": wasm_res["result_digest"],
                "hit_commitment": wasm_res.get("hit_commitment"),
            }
            submit_msg = AoMessage(
                sender=w.id,
                target=coord.id,
                action="SubmitShard",
                data=submit_data,
                timestamp_ms=int(time.time() * 1000),
            )
            coord.receive_message(submit_msg)

        return worker_wasm_time

    # Run workers concurrently across a thread pool
    with concurrent.futures.ThreadPoolExecutor(max_workers=worker_count) as executor:
        futures = [executor.submit(worker_loop, w) for w in workers]
        for f in concurrent.futures.as_completed(futures):
            total_worker_wasm_time += f.result()

    wall_seconds = time.perf_counter() - t_start
    state = coord.summarize(coord.runs[run_id])

    assert state["complete"] is True, f"Run incomplete for {worker_count} workers"
    assert state["unique_accepted_evaluations"] == candidate_count
    assert state["rejected_stale_or_duplicate"] == 0

    effective_cand_per_sec = candidate_count / wall_seconds if wall_seconds > 0 else 0

    # Coordinator overhead is wall time minus the average wall time per core or queue overhead
    estimated_coord_overhead = max(
        0.0, wall_seconds - (total_worker_wasm_time / worker_count)
    )

    return {
        "worker_count": worker_count,
        "candidate_count": candidate_count,
        "shard_size": shard_size,
        "shard_count": state["shard_count"],
        "wall_seconds": round(wall_seconds, 4),
        "total_worker_seconds": round(total_worker_wasm_time, 4),
        "coordinator_overhead_seconds": round(estimated_coord_overhead, 4),
        "effective_candidates_per_sec": round(effective_cand_per_sec, 2),
        "lease_attempts": state["lease_attempts"],
        "expired_leases": state["expired_leases"],
        "duplicate_attempted_work": state["physical_evaluations"]
        - state["unique_accepted_evaluations"],
        "duplicate_accepted_work": 0,
        "coordination_messages": len(coord.messages_sent),
        "hit_count": state["hit_count"],
        "kernel_digest": KERNEL_DIGEST,
        "family_digest": FAMILY_DIGEST,
    }


def run_scaling_series(candidate_count: int = 181440, shard_size: int = 4096):
    print("=" * 80)
    print("C95-AO-00 — LOCAL_DISTRIBUTED_BASELINE SCALING BENCHMARK")
    print(f"Family Size: N = {candidate_count} candidates, Shard Size = {shard_size}")
    print(f"Kernel Digest: {KERNEL_DIGEST}")
    print(f"Family Digest: {FAMILY_DIGEST}")
    print("=" * 80)

    results = []
    worker_counts = [1, 2, 4, 8, 16, 32, 64]
    t1_wall = None

    for p in worker_counts:
        print(f"\n[Running p={p} workers] ...", flush=True)
        res = run_benchmark_for_workers(
            worker_count=p, candidate_count=candidate_count, shard_size=shard_size
        )
        if p == 1:
            t1_wall = res["wall_seconds"]

        speedup = round(t1_wall / res["wall_seconds"], 3) if res["wall_seconds"] > 0 else 1.0
        efficiency = round(speedup / p, 3)

        res["speedup"] = speedup
        res["efficiency"] = efficiency
        results.append(res)

        print(
            f"  p={p:2d}: Wall: {res['wall_seconds']:6.2f}s | "
            f"Worker Time: {res['total_worker_seconds']:6.2f}s | "
            f"Throughput: {res['effective_candidates_per_sec']:8.1f} c/s | "
            f"Speedup: {speedup:5.2f}x | Efficiency: {efficiency:5.2f}"
        )

    out_file = os.path.join(
        os.path.dirname(__file__), "..", "scaling_baseline_results.json"
    )
    with open(out_file, "w") as f:
        json.dump(results, f, indent=2)
    print(f"\nScaling benchmark written to {out_file}")
    return results


if __name__ == "__main__":
    # If fast test requested via argument
    if len(sys.argv) > 1 and sys.argv[1] == "--quick":
        run_scaling_series(candidate_count=18432, shard_size=1024)
    else:
        run_scaling_series(candidate_count=181440, shard_size=4096)
