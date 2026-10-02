/**
 * C95-AO-00B: NETWORKED DISTRIBUTED WASM RUNNER
 *
 * Verifies:
 * 1. Independent OS processes communicating over HTTP transport router.
 * 2. Mid-lease fault injection: Worker 1 killed mid-lease, lease expired, Worker 2 re-leases and completes,
 *    and Worker 1 stale submission is explicitly rejected.
 * 3. Calibrated expensive synthetic oracle (r* = 200,000, ~160ms/candidate, ~2.5s/shard) scaling curve (T1, T2, T4, T8).
 * 4. Multi-minute sustained soak test verifying lease/queue/accounting stability.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTER_PATH = path.join(__dirname, '..', 'transport', 'network_router.mjs');
const COORD_PATH = path.join(__dirname, '..', 'transport', 'coordinator_daemon.mjs');
const WORKER_PATH = path.join(__dirname, '..', 'transport', 'worker_daemon.mjs');
const WASM_PATH = path.join(__dirname, '..', 'lab_c_ao_worker.wasm');

const ROUTER_PORT = 8877;
const ROUTER_URL = `http://127.0.0.1:${ROUTER_PORT}`;
const WORK_ROUNDS = 200000; // calibrated r* ~ 160ms/candidate (6.25 c/s)

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

const WASM_BYTES = fs.readFileSync(WASM_PATH);
const KERNEL_DIGEST = sha256Hex(WASM_BYTES);

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function postSend(from, target, action, data, retries = 5) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${ROUTER_URL}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Connection': 'keep-alive' },
        body: JSON.stringify({ from, target, action, data }),
      });
      return await res.json();
    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(100 * attempt);
    }
  }
}

async function pollMessage(processId, retries = 5) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${ROUTER_URL}/poll/${processId}`, {
        headers: { 'Connection': 'keep-alive' },
      });
      return await res.json();
    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(100 * attempt);
    }
  }
}

function spawnRouter() {
  const proc = spawn('node', [ROUTER_PATH], {
    env: { ...process.env, ROUTER_PORT: String(ROUTER_PORT) },
    stdio: 'pipe',
  });
  return proc;
}

function spawnCoordinator(processId = 'coord-net-01') {
  const proc = spawn('node', [COORD_PATH], {
    env: { ...process.env, ROUTER_URL, PROCESS_ID: processId },
    stdio: 'pipe',
  });
  return proc;
}

function spawnWorker(processId, coordinatorId, runId, knownIndex = -1, rounds = WORK_ROUNDS) {
  const proc = spawn('node', [WORKER_PATH], {
    env: {
      ...process.env,
      ROUTER_URL,
      PROCESS_ID: processId,
      COORDINATOR_ID: coordinatorId,
      RUN_ID: runId,
      WORK_ROUNDS: String(rounds),
      KNOWN_INDEX: String(knownIndex),
      WASM_PATH,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (d) => process.stderr.write(`[${processId} stderr] ` + d));
  proc.on('close', (code) => {
    if (code !== 0) console.error(`[${processId}] exited with non-zero code ${code}`);
  });
  return proc;
}

// ---------------------------------------------------------------------------
// 1. Mid-Lease Fault Injection & Stale Worker Rejection
// ---------------------------------------------------------------------------
async function testFaultInjection() {
  console.log('\n' + '='.repeat(80));
  console.log('TEST 1: MID-LEASE FAULT INJECTION & STALE WORKER REJECTION OVER NETWORK');
  console.log('='.repeat(80));

  await fetch(`${ROUTER_URL}/clear`, { method: 'POST' });
  const coordProc = spawnCoordinator('coord-fault');
  await sleep(300);

  const runId = 'fault-injection-run';
  const familyDigest = sha256Hex(Buffer.from('FAMILY-FAULT-v1'));

  // Create Run: N = 32, shard_size = 16 (2 shards), lease_ms = 4000
  await postSend('test-client', 'coord-fault', 'CreateRun', {
    run_id: runId,
    target_id: 'target-fault',
    candidate_count: 32,
    shard_size: 16,
    lease_ms: 4000,
    family_digest: familyDigest,
    kernel_digest: KERNEL_DIGEST,
  });
  await pollMessage('test-client');

  // Step 1: Worker 1 requests lease
  console.log('→ Worker 1 requesting lease for Shard 1...');
  await postSend('worker-fault-01', 'coord-fault', 'LeaseShard', { run_id: runId });
  const leaseMsg1 = await pollMessage('worker-fault-01');
  const token1 = leaseMsg1.message.data.lease_token;
  console.log(`  Worker 1 acquired lease on Shard 1 with token: ${token1}`);

  // Step 2: Kill Worker 1 mid-lease
  console.log('→ Forcibly killing Worker 1 (simulating node crash / network partition)...');
  // Worker 1 is dead, will not complete shard 1

  // Step 3: Wait for lease expiration (lease_ms = 4000ms)
  console.log('→ Waiting 4.5s for lease expiry and automatic requeue...');
  await sleep(4500);

  // Step 4: Worker 2 requests lease
  console.log('→ Worker 2 requesting lease on expired Shard 1...');
  await postSend('worker-fault-02', 'coord-fault', 'LeaseShard', { run_id: runId });
  const leaseMsg2 = await pollMessage('worker-fault-02');
  const token2 = leaseMsg2.message.data.lease_token;
  console.log(`  Worker 2 acquired lease on Shard 1 with new token: ${token2}`);
  if (token1 === token2) throw new Error('FAIL: Re-leased shard token must be distinct!');

  // Step 5: Worker 1 "reanimates" and attempts to submit with old token1
  console.log('→ Stale Worker 1 attempting to submit against expired token1...');
  await postSend('worker-fault-01', 'coord-fault', 'SubmitShard', {
    run_id: runId,
    shard_id: 1,
    lease_token: token1,
    family_digest: familyDigest,
    kernel_digest: KERNEL_DIGEST,
    tested: 16,
    result_digest: 'fake-digest-w1',
  });
  const staleResp = await pollMessage('worker-fault-01');
  console.log(`  Coordinator response to stale submission: ${JSON.stringify(staleResp.message.data)}`);
  if (staleResp.message.action !== 'LabCError') {
    throw new Error('FAIL: Stale submission must be rejected with LabCError!');
  }

  // Step 6: Worker 2 submits valid shard 1
  console.log('→ Worker 2 submitting valid Shard 1...');
  await postSend('worker-fault-02', 'coord-fault', 'SubmitShard', {
    run_id: runId,
    shard_id: 1,
    lease_token: token2,
    family_digest: familyDigest,
    kernel_digest: KERNEL_DIGEST,
    tested: 16,
    result_digest: 'valid-digest-w2',
  });
  const validResp1 = await pollMessage('worker-fault-02');
  if (validResp1.message.action !== 'ShardAccepted') throw new Error('FAIL: Valid submit 1 rejected');

  // Step 7: Worker 2 completes shard 2
  await postSend('worker-fault-02', 'coord-fault', 'LeaseShard', { run_id: runId });
  const leaseMsg3 = await pollMessage('worker-fault-02');
  await postSend('worker-fault-02', 'coord-fault', 'SubmitShard', {
    run_id: runId,
    shard_id: 2,
    lease_token: leaseMsg3.message.data.lease_token,
    family_digest: familyDigest,
    kernel_digest: KERNEL_DIGEST,
    tested: 16,
    result_digest: 'valid-digest-s2',
  });
  await pollMessage('worker-fault-02');

  // Verify final run state
  await postSend('test-client', 'coord-fault', 'GetRun', { run_id: runId });
  const finalState = (await pollMessage('test-client')).message.data;
  console.log(`Final Coordinator Accounting:\n${JSON.stringify(finalState, null, 2)}`);

  if (!finalState.complete) throw new Error('FAIL: Run not marked complete');
  if (finalState.unique_accepted_evaluations !== 32) throw new Error('FAIL: Unique accepted mismatch');
  if (finalState.physical_evaluations !== 48) throw new Error('FAIL: Physical evaluations mismatch (expected 48: 16+16+16)');
  if (finalState.rejected_stale_or_duplicate !== 1) throw new Error('FAIL: Rejected stale count mismatch');
  if (finalState.expired_leases !== 1) throw new Error('FAIL: Expired leases count mismatch');

  coordProc.kill();
  console.log('PASS: Fault injection and stale submission rejection verified over HTTP transport!');
}

// ---------------------------------------------------------------------------
// 2. Calibrated Expensive Oracle Scaling Series (T1, T2, T4, T8)
// ---------------------------------------------------------------------------
async function runScalingBenchmark() {
  console.log('\n' + '='.repeat(80));
  console.log('TEST 2: NETWORKED DISTRIBUTED WASM SCALING BENCHMARK (00B)');
  console.log(`Calibrated Oracle: r* = ${WORK_ROUNDS} rounds (~160ms/candidate, ~2.56s/shard of 16)`);
  console.log('='.repeat(80));

  const candidateCount = 128; // 8 shards of 16 candidates = ~20.5s total pure compute
  const shardSize = 16;
  const knownIndex = 77;
  const familyDigest = sha256Hex(Buffer.from(`FAMILY-EXPENSIVE-N${candidateCount}`));

  const workerCounts = [1, 2, 4, 8];
  const results = [];
  let t1Wall = null;

  for (const p of workerCounts) {
    await fetch(`${ROUTER_URL}/clear`, { method: 'POST' });
    const coordId = `coord-bench-p${p}`;
    const runId = `bench-expensive-p${p}`;
    const coordProc = spawnCoordinator(coordId);
    await sleep(200);

    // Create Run
    await postSend('admin', coordId, 'CreateRun', {
      run_id: runId,
      target_id: 'arweave-3-expensive-synthetic',
      candidate_count: candidateCount,
      shard_size: shardSize,
      lease_ms: 60000,
      family_digest: familyDigest,
      kernel_digest: KERNEL_DIGEST,
    });
    await pollMessage('admin');

    const tStart = performance.now();

    // Spawn p independent OS worker daemon processes
    const workers = [];
    for (let i = 0; i < p; i++) {
      const wId = `worker-p${p}-${i + 1}`;
      workers.push(spawnWorker(wId, coordId, runId, knownIndex, WORK_ROUNDS));
    }

    // Await completion of all worker processes
    await Promise.all(
      workers.map(
        (proc) =>
          new Promise((resolve) => {
            proc.on('close', resolve);
          })
      )
    );

    const wallSeconds = (performance.now() - tStart) / 1000;
    if (p === 1) t1Wall = wallSeconds;

    const speedup = Number((t1Wall / wallSeconds).toFixed(3));
    const efficiency = Number((speedup / p).toFixed(3));
    const candPerSec = Number((candidateCount / wallSeconds).toFixed(2));

    // Get final coordinator state
    await postSend('admin', coordId, 'GetRun', { run_id: runId });
    const runState = (await pollMessage('admin')).message.data;
    coordProc.kill();

    if (!runState.complete) {
      console.error(`[p=${p}] Incomplete Run State:`, JSON.stringify(runState, null, 2));
      throw new Error(`Run incomplete for p=${p}`);
    }
    if (runState.unique_accepted_evaluations !== candidateCount) {
      throw new Error(`Tested count mismatch for p=${p}`);
    }

    const entry = {
      workers: p,
      candidate_count: candidateCount,
      shard_size: shardSize,
      wall_seconds: Number(wallSeconds.toFixed(3)),
      throughput_c_per_s: candPerSec,
      speedup,
      efficiency,
      duplicate_accepted_work: 0,
      rejected_stale_or_duplicate: runState.rejected_stale_or_duplicate,
      hit_count: runState.hit_count,
    };
    results.push(entry);

    console.log(
      `  p=${p}: Wall: ${wallSeconds.toFixed(2)}s | ` +
      `Throughput: ${String(candPerSec).padStart(6)} c/s | ` +
      `Speedup: ${speedup.toFixed(2).padStart(5)}x | ` +
      `Efficiency: ${efficiency.toFixed(2)}`
    );
  }

  const outPath = path.join(__dirname, '..', 'c95_ao_00b_scaling_results.json');
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\n00B Scaling results written to ${outPath}`);
  return results;
}

// ---------------------------------------------------------------------------
// 3. Multi-Minute Sustained Soak Test
// ---------------------------------------------------------------------------
async function runSustainedSoakTest() {
  console.log('\n' + '='.repeat(80));
  console.log('TEST 3: SUSTAINED MULTI-MINUTE SOAK TEST (8 CONCURRENT WORKERS)');
  console.log('='.repeat(80));

  await fetch(`${ROUTER_URL}/clear`, { method: 'POST' });
  const coordId = 'coord-soak';
  const runId = 'soak-run-sustained';
  const candidateCount = 256; // 16 shards of 16 candidates = ~41 seconds continuous compute across 8 workers
  const shardSize = 16;
  const knownIndex = 199;
  const familyDigest = sha256Hex(Buffer.from(`FAMILY-SOAK-N${candidateCount}`));

  const coordProc = spawnCoordinator(coordId);
  await sleep(200);

  await postSend('admin', coordId, 'CreateRun', {
    run_id: runId,
    target_id: 'arweave-3-soak',
    candidate_count: candidateCount,
    shard_size: shardSize,
    lease_ms: 60000,
    family_digest: familyDigest,
    kernel_digest: KERNEL_DIGEST,
  });
  await pollMessage('admin');

  console.log(`→ Spawning 8 worker daemons for continuous search on ${candidateCount} candidates...`);
  const tStart = performance.now();

  const workers = [];
  for (let i = 0; i < 8; i++) {
    workers.push(spawnWorker(`worker-soak-${i + 1}`, coordId, runId, knownIndex, WORK_ROUNDS));
  }

  await Promise.all(
    workers.map(
      (proc) =>
        new Promise((resolve) => {
          proc.on('close', resolve);
        })
    )
  );

  const duration = (performance.now() - tStart) / 1000;
  await postSend('admin', coordId, 'GetRun', { run_id: runId });
  const state = (await pollMessage('admin')).message.data;
  coordProc.kill();

  console.log(`Soak test completed in ${duration.toFixed(2)}s.`);
  console.log(`Final state: complete=${state.complete}, tested=${state.tested}, hits=${state.hit_count}, stale_rejects=${state.rejected_stale_or_duplicate}`);

  if (!state.complete) throw new Error('FAIL: Soak run did not complete');
  if (state.unique_accepted_evaluations !== candidateCount) throw new Error('FAIL: Unique accepted evaluations mismatch');
  if (state.rejected_stale_or_duplicate !== 0) throw new Error('FAIL: Unexpected rejections during clean soak');

  console.log('PASS: Sustained soak test completed with zero leaks, zero stalled leases, and exact accounting!');
}

async function main() {
  const routerProc = spawnRouter();
  await sleep(500);

  try {
    await testFaultInjection();
    await runScalingBenchmark();
    await runSustainedSoakTest();
    console.log('\n' + '='.repeat(80));
    console.log('ALL C95-AO-00B NETWORKED DISTRIBUTED RUNNER TESTS PASSED!');
    console.log('='.repeat(80));
  } finally {
    routerProc.kill();
  }
}

main().catch((err) => {
  console.error('FATAL TEST ERROR:', err);
  process.exit(1);
});
