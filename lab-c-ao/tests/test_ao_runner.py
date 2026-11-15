"""
Unit and integration tests for Lab C AO Distributed Runner.

Covers:
- Gate D: Single-worker known-answer run & determinism
- Gate E: Failure injection, lease expiry, and stale submission rejection
- Security & quarantine: plaintext secret rejection, digest mismatch rejection
- Accounting invariants: mathematical coverage, unique vs physical evaluations
"""

import hashlib
import json
import os
import sys

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
FAMILY_DIGEST = hashlib.sha256(b"LAB-C-AO-SYNTHETIC-FAMILY-v1|N=4608").hexdigest()


def test_gate_d_single_worker_known_answer():
    """Gate D — Single-worker known-answer run.

    Verifies:
    - candidate count exactly equals N
    - expected known-answer commitment appears
    - result digest is deterministic across repeated runs
    - coordinator reaches complete=true
    - no gaps, zero duplicate completions
    """
    N = 4608
    SHARD_SIZE = 1024
    KNOWN_INDEX = 3137
    RUN_ID = "gate-d-single-worker-run-1"

    coord = AoCoordinator("coord-d")
    create_msg = AoMessage(
        sender="client",
        target=coord.id,
        action="CreateRun",
        data={
            "run_id": RUN_ID,
            "target_id": "synthetic-target-d",
            "candidate_count": N,
            "shard_size": SHARD_SIZE,
            "family_digest": FAMILY_DIGEST,
            "kernel_digest": KERNEL_DIGEST,
            "lease_ms": 60000,
        },
        timestamp_ms=1000,
    )
    init_res = coord.receive_message(create_msg)
    assert init_res.action == "RunCreated"
    assert init_res.data["candidate_count"] == N
    assert init_res.data["shard_count"] == 5  # ceil(4608 / 1024)

    worker = AoWorker(
        worker_id="worker-single",
        coordinator=coord,
        family_digest=FAMILY_DIGEST,
        kernel_digest=KERNEL_DIGEST,
        known_index=KNOWN_INDEX,
    )

    t = 2000
    while True:
        resp = worker.step(RUN_ID, timestamp_ms=t)
        t += 100
        if not resp:
            break
        if resp.action == "NoShard":
            break
        assert resp.action == "ShardAccepted"

    state = coord.summarize(coord.runs[RUN_ID])
    assert state["complete"] is True
    assert state["done"] == 5
    assert state["tested"] == N
    assert state["mathematical_candidates"] == N
    assert state["unique_accepted_evaluations"] == N
    assert state["physical_evaluations"] == N
    assert state["rejected_stale_or_duplicate"] == 0
    assert state["hit_count"] == 1

    # Verify hit commitment matches expected formula: SHA256("LAB-C-WIN-v1" || run_id || candidate_bytes)
    candidate_bytes = KNOWN_INDEX.to_bytes(8, "big")
    expected_commitment = hashlib.sha256(
        b"LAB-C-WIN-v1" + RUN_ID.encode("utf8") + candidate_bytes
    ).hexdigest()
    assert state["hits"][0]["hit_commitment"] == expected_commitment

    # Repeated run must produce identical result digests and accounting
    coord2 = AoCoordinator("coord-d2")
    coord2.receive_message(create_msg)
    worker2 = AoWorker(
        worker_id="worker-single-2",
        coordinator=coord2,
        family_digest=FAMILY_DIGEST,
        kernel_digest=KERNEL_DIGEST,
        known_index=KNOWN_INDEX,
    )
    t = 2000
    while True:
        resp = worker2.step(RUN_ID, timestamp_ms=t)
        t += 100
        if not resp or resp.action == "NoShard":
            break

    state2 = coord2.summarize(coord2.runs[RUN_ID])
    assert state2 == state
    print("PASS: Gate D (Single-worker known-answer run)")


def test_gate_e_failure_injection_and_stale_rejection():
    """Gate E — Failure injection:

    - lease shard to Worker A
    - expire lease and requeue
    - lease shard to Worker B (new lease token)
    - Worker A submits stale result -> REJECTED
    - Worker B submits valid result -> ACCEPTED
    - final accounting exact
    """
    N = 2048
    SHARD_SIZE = 1024
    KNOWN_INDEX = 1500
    RUN_ID = "gate-e-fault-run"

    coord = AoCoordinator("coord-e")
    coord.receive_message(
        AoMessage(
            sender="client",
            target=coord.id,
            action="CreateRun",
            data={
                "run_id": RUN_ID,
                "target_id": "synthetic-target-e",
                "candidate_count": N,
                "shard_size": SHARD_SIZE,
                "family_digest": FAMILY_DIGEST,
                "kernel_digest": KERNEL_DIGEST,
                "lease_ms": 10000,
            },
            timestamp_ms=1000,
        )
    )

    # 1. Worker A leases shard 1 at t=1000
    lease_a_resp = coord.receive_message(
        AoMessage(
            sender="worker-A",
            target=coord.id,
            action="LeaseShard",
            data={"run_id": RUN_ID},
            timestamp_ms=1000,
        )
    )
    assert lease_a_resp.action == "ShardLease"
    token_a = lease_a_resp.data["lease_token"]
    assert lease_a_resp.data["shard_id"] == 1

    # 2. Worker A computes shard 1
    wasm_res_a, _ = invoke_wasm_shard(
        0, 1024, KNOWN_INDEX, RUN_ID, WASM_BINARY_PATH
    )

    # 3. Simulate Worker A hung/delayed: advance time to t=12000 (past lease_ms=10000)
    # Coordinator requeues expired shards
    requeue_resp = coord.receive_message(
        AoMessage(
            sender="monitor",
            target=coord.id,
            action="RequeueExpired",
            data={"run_id": RUN_ID},
            timestamp_ms=12000,
        )
    )
    assert requeue_resp.data["count"] == 1
    assert requeue_resp.data["state"]["ready"] == 2  # Shard 1 back to ready

    # 4. Worker B leases shard 1 at t=12500
    lease_b_resp = coord.receive_message(
        AoMessage(
            sender="worker-B",
            target=coord.id,
            action="LeaseShard",
            data={"run_id": RUN_ID},
            timestamp_ms=12500,
        )
    )
    assert lease_b_resp.action == "ShardLease"
    assert lease_b_resp.data["shard_id"] == 1
    token_b = lease_b_resp.data["lease_token"]
    assert token_b != token_a

    # 5. Worker A wakes up and attempts to submit stale shard 1 with token_a
    stale_submit_resp = coord.receive_message(
        AoMessage(
            sender="worker-A",
            target=coord.id,
            action="SubmitShard",
            data={
                "run_id": RUN_ID,
                "shard_id": 1,
                "lease_token": token_a,
                "family_digest": FAMILY_DIGEST,
                "kernel_digest": KERNEL_DIGEST,
                "tested": wasm_res_a["tested"],
                "result_digest": wasm_res_a["result_digest"],
                "hit_commitment": wasm_res_a.get("hit_commitment"),
            },
            timestamp_ms=13000,
        )
    )
    # Stale submit MUST be rejected
    assert stale_submit_resp.action == "LabCError"
    assert "stale" in stale_submit_resp.data["error"] or "mismatch" in stale_submit_resp.data["error"]

    # 6. Worker B submits valid shard 1
    wasm_res_b, _ = invoke_wasm_shard(
        0, 1024, KNOWN_INDEX, RUN_ID, WASM_BINARY_PATH
    )
    valid_submit_resp = coord.receive_message(
        AoMessage(
            sender="worker-B",
            target=coord.id,
            action="SubmitShard",
            data={
                "run_id": RUN_ID,
                "shard_id": 1,
                "lease_token": token_b,
                "family_digest": FAMILY_DIGEST,
                "kernel_digest": KERNEL_DIGEST,
                "tested": wasm_res_b["tested"],
                "result_digest": wasm_res_b["result_digest"],
                "hit_commitment": wasm_res_b.get("hit_commitment"),
            },
            timestamp_ms=13500,
        )
    )
    assert valid_submit_resp.action == "ShardAccepted"

    # Complete shard 2 with Worker B
    lease_shard2 = coord.receive_message(
        AoMessage(
            sender="worker-B",
            target=coord.id,
            action="LeaseShard",
            data={"run_id": RUN_ID},
            timestamp_ms=14000,
        )
    )
    wasm_res_s2, _ = invoke_wasm_shard(
        1024, 2048, KNOWN_INDEX, RUN_ID, WASM_BINARY_PATH
    )
    coord.receive_message(
        AoMessage(
            sender="worker-B",
            target=coord.id,
            action="SubmitShard",
            data={
                "run_id": RUN_ID,
                "shard_id": 2,
                "lease_token": lease_shard2.data["lease_token"],
                "family_digest": FAMILY_DIGEST,
                "kernel_digest": KERNEL_DIGEST,
                "tested": wasm_res_s2["tested"],
                "result_digest": wasm_res_s2["result_digest"],
                "hit_commitment": wasm_res_s2.get("hit_commitment"),
            },
            timestamp_ms=14500,
        )
    )

    state = coord.summarize(coord.runs[RUN_ID])
    assert state["complete"] is True
    assert state["mathematical_candidates"] == N
    assert state["unique_accepted_evaluations"] == N
    assert state["physical_evaluations"] == 3072  # 1024 (A) + 1024 (B shard 1) + 1024 (B shard 2)
    assert state["rejected_stale_or_duplicate"] == 1
    assert state["accepted_completions"] == 2
    assert state["expired_leases"] >= 1
    print("PASS: Gate E (Failure injection, lease expiry, and stale rejection)")


def test_digest_and_secret_quarantine():
    """Verify security firewalls:

    1. Family digest mismatch rejected
    2. Kernel digest mismatch rejected
    3. Plaintext secret fields strictly rejected
    """
    RUN_ID = "quarantine-run"
    coord = AoCoordinator("coord-q")
    coord.receive_message(
        AoMessage(
            sender="client",
            target=coord.id,
            action="CreateRun",
            data={
                "run_id": RUN_ID,
                "target_id": "target-q",
                "candidate_count": 100,
                "shard_size": 100,
                "family_digest": FAMILY_DIGEST,
                "kernel_digest": KERNEL_DIGEST,
                "lease_ms": 60000,
            },
            timestamp_ms=1000,
        )
    )

    lease_resp = coord.receive_message(
        AoMessage(
            sender="worker-q",
            target=coord.id,
            action="LeaseShard",
            data={"run_id": RUN_ID},
            timestamp_ms=1000,
        )
    )
    token = lease_resp.data["lease_token"]

    # 1. Family digest mismatch
    r1 = coord.receive_message(
        AoMessage(
            sender="worker-q",
            target=coord.id,
            action="SubmitShard",
            data={
                "run_id": RUN_ID,
                "shard_id": 1,
                "lease_token": token,
                "family_digest": "corrupted-family-digest",
                "kernel_digest": KERNEL_DIGEST,
                "tested": 100,
                "result_digest": "abc",
            },
            timestamp_ms=1100,
        )
    )
    assert r1.action == "LabCError"
    assert "digest mismatch" in r1.data["error"]

    # 2. Kernel digest mismatch
    r2 = coord.receive_message(
        AoMessage(
            sender="worker-q",
            target=coord.id,
            action="SubmitShard",
            data={
                "run_id": RUN_ID,
                "shard_id": 1,
                "lease_token": token,
                "family_digest": FAMILY_DIGEST,
                "kernel_digest": "corrupted-kernel-digest",
                "tested": 100,
                "result_digest": "abc",
            },
            timestamp_ms=1100,
        )
    )
    assert r2.action == "LabCError"
    assert "digest mismatch" in r2.data["error"]

    # 3. Plaintext secret rejection
    for forbidden in ["secret", "private_key", "seed", "mnemonic"]:
        r_secret = coord.receive_message(
            AoMessage(
                sender="worker-q",
                target=coord.id,
                action="SubmitShard",
                data={
                    "run_id": RUN_ID,
                    "shard_id": 1,
                    "lease_token": token,
                    "family_digest": FAMILY_DIGEST,
                    "kernel_digest": KERNEL_DIGEST,
                    "tested": 100,
                    "result_digest": "abc",
                    forbidden: "plaintext-secret-material-12345",
                },
                timestamp_ms=1100,
            )
        )
        assert r_secret.action == "LabCError"
        assert "plaintext secret rejected" in r_secret.data["error"]

    print("PASS: Security & Quarantine (digest & secret rejection)")


if __name__ == "__main__":
    print(f"Kernel Digest: {KERNEL_DIGEST}")
    print(f"Family Digest: {FAMILY_DIGEST}")
    test_gate_d_single_worker_known_answer()
    test_gate_e_failure_injection_and_stale_rejection()
    test_digest_and_secret_quarantine()
    print("ALL INTEGRATION TESTS PASSED SUCCESSFULLY!")
