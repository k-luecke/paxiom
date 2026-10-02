"""
Lab C AO Distributed Runner Test and Simulation Harness.

Provides an in-process, deterministic AO environment supporting:
- Process message routing (ao.send, Handlers)
- Coordinator state machine matching coordinator.lua
- Worker transport matching worker.lua
- Real invocation of lab_c_ao_worker.wasm via wasm_runner.mjs
- Precise accounting counters per C95-AO-00 requirements
- Fault injection (worker drops, lease expiration, stale submission)
- Multi-worker concurrent execution and benchmarking
"""

import json
import math
import os
import subprocess
import time
from typing import Dict, List, Optional, Tuple, Any

WASM_RUNNER_PATH = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "wasm_runner.mjs")
)
WASM_BINARY_PATH = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "lab_c_ao_worker.wasm")
)


def invoke_wasm_shard(
    start: int,
    end: int,
    known_index: int,
    run_id: str,
    wasm_path: str = WASM_BINARY_PATH,
) -> Tuple[Dict[str, Any], float]:
    """Invokes the compiled Rust WASM kernel via the reference Node.js WebAssembly host runner.

    Returns the parsed result dict and the execution duration in seconds.
    """
    t0 = time.perf_counter()
    cmd = [
        "node",
        WASM_RUNNER_PATH,
        str(start),
        str(end),
        str(known_index),
        run_id,
        wasm_path,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, check=True)
    duration = time.perf_counter() - t0
    res = json.loads(proc.stdout.strip())
    return res, duration


class AoMessage:
    def __init__(
        self,
        sender: str,
        target: str,
        action: str,
        data: Dict[str, Any],
        timestamp_ms: int,
    ):
        self.sender = sender
        self.target = target
        self.action = action
        self.data = data
        self.timestamp_ms = timestamp_ms


class AoCoordinator:
    """Python implementation of coordinator.lua for harness and benchmarking."""

    def __init__(self, process_id: str = "coordinator"):
        self.id = process_id
        self.runs: Dict[str, Dict[str, Any]] = {}
        self.messages_sent: List[AoMessage] = []
        self.current_time_ms: int = 1000

    def receive_message(self, msg: AoMessage) -> Optional[AoMessage]:
        now = msg.timestamp_ms or self.current_time_ms
        action = msg.action
        d = msg.data

        if action == "CreateRun":
            run_id = d.get("run_id")
            if not run_id:
                return self._fail(msg, "missing run_id")
            if run_id in self.runs:
                return self._fail(msg, "run_id already exists")
            n = d.get("candidate_count")
            z = d.get("shard_size")
            lease_ms = d.get("lease_ms", 120000)
            if not n or n < 1:
                return self._fail(msg, "invalid candidate_count")
            if not z or z < 1:
                return self._fail(msg, "invalid shard_size")
            if lease_ms < 1000:
                return self._fail(msg, "lease_ms too small")
            if not d.get("family_digest") or not d.get("kernel_digest"):
                return self._fail(msg, "digests required")

            shards = []
            i = 0
            sid = 0
            while i < n:
                e = min(i + z, n)
                sid += 1
                shards.append(
                    {
                        "shard_id": sid,
                        "start_index": i,
                        "end_index": e,
                        "status": "ready",
                        "attempts": 0,
                        "worker": None,
                        "lease_expires_ms": None,
                        "lease_token": None,
                        "result_digest": None,
                    }
                )
                i = e

            run = {
                "run_id": run_id,
                "target_id": d.get("target_id", "test-target"),
                "family_digest": d["family_digest"],
                "kernel_digest": d["kernel_digest"],
                "candidate_count": n,
                "shard_size": z,
                "lease_ms": lease_ms,
                "shards": shards,
                "hits": [],
                "physical_evaluations": 0,
                "rejected_stale_or_duplicate": 0,
                "expired_leases": 0,
            }
            self.runs[run_id] = run
            return self._reply(msg, "RunCreated", self.summarize(run))

        elif action == "LeaseShard":
            run_id = d.get("run_id")
            run = self.runs.get(run_id)
            if not run:
                return self._fail(msg, "unknown run")
            self._requeue_expired(run, now)
            shard = self._next_ready_shard(run)
            if not shard:
                return self._reply(msg, "NoShard", self.summarize(run))

            shard["status"] = "leased"
            shard["worker"] = msg.sender
            shard["attempts"] = (shard.get("attempts") or 0) + 1
            shard["lease_expires_ms"] = now + run["lease_ms"]
            shard["lease_token"] = (
                f"{run['run_id']}:{shard['shard_id']}:{shard['attempts']}:{shard['lease_expires_ms']}"
            )
            run["physical_evaluations"] += (
                shard["end_index"] - shard["start_index"]
            )

            payload = {
                "run_id": run["run_id"],
                "target_id": run["target_id"],
                "family_digest": run["family_digest"],
                "kernel_digest": run["kernel_digest"],
                "shard_id": shard["shard_id"],
                "start_index": shard["start_index"],
                "end_index": shard["end_index"],
                "lease_token": shard["lease_token"],
                "lease_expires_ms": shard["lease_expires_ms"],
            }
            return self._reply(msg, "ShardLease", payload)

        elif action == "SubmitShard":
            run_id = d.get("run_id")
            run = self.runs.get(run_id)
            if not run:
                return self._fail(msg, "unknown run")
            self._requeue_expired(run, now)
            sid = d.get("shard_id", 0)
            if sid < 1 or sid > len(run["shards"]):
                return self._fail(msg, "unknown shard")
            shard = run["shards"][sid - 1]

            if shard["status"] != "leased":
                run["rejected_stale_or_duplicate"] += 1
                return self._fail(msg, "shard not leased")
            if shard["worker"] != msg.sender:
                run["rejected_stale_or_duplicate"] += 1
                return self._fail(msg, "lease owner mismatch")
            if d.get("lease_token") != shard["lease_token"]:
                run["rejected_stale_or_duplicate"] += 1
                return self._fail(msg, "stale lease token")
            if (
                d.get("family_digest") != run["family_digest"]
                or d.get("kernel_digest") != run["kernel_digest"]
            ):
                return self._fail(msg, "digest mismatch")

            expected = shard["end_index"] - shard["start_index"]
            if d.get("tested") != expected:
                return self._fail(msg, "tested count mismatch")
            if any(k in d for k in ["secret", "private_key", "seed", "mnemonic"]):
                return self._fail(msg, "plaintext secret rejected")
            if not d.get("result_digest"):
                return self._fail(msg, "result_digest required")

            shard["status"] = "done"
            shard["result_digest"] = d["result_digest"]
            shard["worker"] = None
            shard["lease_expires_ms"] = None
            shard["lease_token"] = None

            if d.get("hit_commitment"):
                run["hits"].append(
                    {
                        "shard_id": shard["shard_id"],
                        "hit_commitment": d["hit_commitment"],
                        "result_digest": d["result_digest"],
                    }
                )

            return self._reply(msg, "ShardAccepted", self.summarize(run))

        elif action == "RequeueExpired":
            run_id = d.get("run_id")
            run = self.runs.get(run_id)
            if not run:
                return self._fail(msg, "unknown run")
            count = self._requeue_expired(run, now)
            return self._reply(
                msg,
                "ExpiredRequeued",
                {"count": count, "state": self.summarize(run)},
            )

        elif action == "GetRun":
            run_id = d.get("run_id")
            run = self.runs.get(run_id)
            if not run:
                return self._fail(msg, "unknown run")
            self._requeue_expired(run, now)
            return self._reply(msg, "RunState", self.summarize(run))

        return self._fail(msg, f"unsupported action {action}")

    def _next_ready_shard(self, run: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        for s in run["shards"]:
            if s["status"] == "ready":
                return s
        return None

    def _requeue_expired(self, run: Dict[str, Any], now: int) -> int:
        n = 0
        for s in run["shards"]:
            if (
                s["status"] == "leased"
                and s["lease_expires_ms"] is not None
                and now >= s["lease_expires_ms"]
            ):
                s["status"] = "ready"
                s["worker"] = None
                s["lease_expires_ms"] = None
                s["lease_token"] = None
                s["attempts"] = (s["attempts"] or 1)
                run["expired_leases"] += 1
                n += 1
        return n

    def summarize(self, run: Dict[str, Any]) -> Dict[str, Any]:
        done, leased, ready, tested, attempts = 0, 0, 0, 0, 0
        for s in run["shards"]:
            attempts += s["attempts"] or 0
            if s["status"] == "done":
                done += 1
                tested += s["end_index"] - s["start_index"]
            elif s["status"] == "leased":
                leased += 1
            else:
                ready += 1

        return {
            "run_id": run["run_id"],
            "target_id": run["target_id"],
            "family_digest": run["family_digest"],
            "kernel_digest": run["kernel_digest"],
            "candidate_count": run["candidate_count"],
            "shard_count": len(run["shards"]),
            "done": done,
            "leased": leased,
            "ready": ready,
            "tested": tested,
            "complete": (done == len(run["shards"])),
            "hit_count": len(run["hits"]),
            "hits": list(run["hits"]),
            "lease_attempts": attempts,
            "expired_leases": run["expired_leases"],
            # Explicit accounting counters:
            "mathematical_candidates": run["candidate_count"],
            "unique_accepted_evaluations": tested,
            "physical_evaluations": run["physical_evaluations"],
            "accepted_completions": done,
            "rejected_stale_or_duplicate": run["rejected_stale_or_duplicate"],
        }

    def _reply(
        self, origin_msg: AoMessage, action: str, data: Dict[str, Any]
    ) -> AoMessage:
        rep = AoMessage(
            sender=self.id,
            target=origin_msg.sender,
            action=action,
            data=data,
            timestamp_ms=self.current_time_ms,
        )
        self.messages_sent.append(rep)
        return rep

    def _fail(self, origin_msg: AoMessage, err: str) -> AoMessage:
        return self._reply(origin_msg, "LabCError", {"error": err})


class AoWorker:
    """Worker transport implementation matching worker.lua with WASM execution."""

    def __init__(
        self,
        worker_id: str,
        coordinator: AoCoordinator,
        family_digest: str,
        kernel_digest: str,
        known_index: int = -1,
        wasm_path: str = WASM_BINARY_PATH,
    ):
        self.id = worker_id
        self.coordinator = coordinator
        self.family_digest = family_digest
        self.kernel_digest = kernel_digest
        self.known_index = known_index
        self.wasm_path = wasm_path
        self.total_worker_wasm_time = 0.0

    def step(self, run_id: str, timestamp_ms: int) -> Optional[AoMessage]:
        """Requests a shard lease, executes the WASM kernel if granted, and submits result."""
        lease_req = AoMessage(
            sender=self.id,
            target=self.coordinator.id,
            action="LeaseShard",
            data={"run_id": run_id},
            timestamp_ms=timestamp_ms,
        )
        resp = self.coordinator.receive_message(lease_req)
        if not resp or resp.action != "ShardLease":
            return resp

        shard_data = resp.data
        # Digest verification
        if (
            shard_data.get("family_digest") != self.family_digest
            or shard_data.get("kernel_digest") != self.kernel_digest
        ):
            reject_msg = AoMessage(
                sender=self.id,
                target=self.coordinator.id,
                action="WorkerReject",
                data={
                    "run_id": run_id,
                    "shard_id": shard_data["shard_id"],
                    "error": "digest mismatch",
                },
                timestamp_ms=timestamp_ms,
            )
            return self.coordinator.receive_message(reject_msg)

        # Execute WASM kernel
        wasm_res, duration = invoke_wasm_shard(
            start=shard_data["start_index"],
            end=shard_data["end_index"],
            known_index=self.known_index,
            run_id=run_id,
            wasm_path=self.wasm_path,
        )
        self.total_worker_wasm_time += duration

        # Secret quarantine: verify no plaintext secrets are present
        for forbidden in ["secret", "private_key", "seed", "mnemonic"]:
            if forbidden in wasm_res:
                raise ValueError(
                    f"Quarantine breach: forbidden field {forbidden} emitted by wasm runner"
                )

        submit_data = {
            "run_id": run_id,
            "shard_id": shard_data["shard_id"],
            "lease_token": shard_data["lease_token"],
            "family_digest": self.family_digest,
            "kernel_digest": self.kernel_digest,
            "tested": wasm_res["tested"],
            "result_digest": wasm_res["result_digest"],
            "hit_commitment": wasm_res.get("hit_commitment"),
        }

        submit_msg = AoMessage(
            sender=self.id,
            target=self.coordinator.id,
            action="SubmitShard",
            data=submit_data,
            timestamp_ms=timestamp_ms,
        )
        return self.coordinator.receive_message(submit_msg)
