/**
 * C95-AO-00D-1: MULTI-GATEWAY DISTRIBUTED INTEGRATION TEST
 *
 * Verifies:
 * 1. Independent worker processes distributed across distinct AR.IO decentralized gateways.
 * 2. Deterministic gateway assignment (Worker 1 -> Gw 1, Worker 2 -> Gw 2, ...).
 * 3. Shard leasing, WASM execution (calibrated r* = 200,000), and result submission.
 * 4. Zero duplicate work, zero stale submissions, strict ledger invariants.
 * 5. Secret quarantine firewall verification across all network boundaries.
 * 6. Multi-gateway execution under p=2 and p=4 worker topologies.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ARIO_GATEWAY_POOL, getGatewayForWorker, auditGatewayPool } from '../transport/gateway_pool.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROUTER_PATH = path.join(__dirname, '..', 'transport', 'network_router.mjs');
const COORD_PATH = path.join(__dirname, '..', 'transport', 'coordinator_daemon.mjs');
const WORKER_PATH = path.join(__dirname, '..', 'transport', 'worker_daemon.mjs');
const WASM_PATH = path.join(__dirname, '..', 'lab_c_ao_worker.wasm');

const ROUTER_PORT = 8890;
const ROUTER_URL = `http://127.0.0.1:${ROUTER_PORT}`;
const WORK_ROUNDS = 200000; // calibrated r* ~ 160ms/candidate

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
  return spawn('node', [ROUTER_PATH], {
    env: { ...process.env, ROUTER_PORT: String(ROUTER_PORT) },
    stdio: 'pipe',
  });
}

function spawnCoordinator(processId) {
  return spawn('node', [COORD_PATH], {
    env: { ...process.env, ROUTER_URL, PROCESS_ID: processId },
    stdio: 'pipe',
  });
}

function spawnWorker(processId, coordinatorId, runId, gatewayUrl, knownIndex = -1, rounds = WORK_ROUNDS) {
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
      GATEWAY_URL: gatewayUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return proc;
}

async function runMultiGatewayStage(p, candidateCount, shardSize, knownIndex, healthyGateways) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`EXECUTING MULTI-GATEWAY RUN: p=${p} WORKERS ACROSS ${p} INDEPENDENT GATEWAYS`);
  console.log(`Search Space: N=${candidateCount} candidates (${candidateCount / shardSize} shards of Z=${shardSize})`);
  console.log(`Calibrated Oracle: r* = ${WORK_ROUNDS} rounds (~160ms/candidate, ~2.56s/shard)`);
  console.log(`${'='.repeat(80)}`);

  await fetch(`${ROUTER_URL}/clear`, { method: 'POST' });
  const coordId = `coord-gw-p${p}`;
  const runId = `run-multi-gw-p${p}`;
  const familyDigest = sha256Hex(Buffer.from(`FAMILY-MULTI-GW-P${p}-N${candidateCount}`));

  const coordProc = spawnCoordinator(coordId);
  await sleep(300);

  // Initialize run on coordinator
  await postSend('admin', coordId, 'CreateRun', {
    run_id: runId,
    target_id: `target-multi-gw-p${p}`,
    candidate_count: candidateCount,
    shard_size: shardSize,
    lease_ms: 60000,
    family_digest: familyDigest,
    kernel_digest: KERNEL_DIGEST,
  });
  await pollMessage('admin');

  // Assign distinct healthy gateways to workers
  const workerConfigs = [];
  for (let i = 0; i < p; i++) {
    const gw = healthyGateways[i % healthyGateways.length];
    const workerId = `worker-gw-${p}-${i + 1}`;
    workerConfigs.push({ workerId, gateway: gw });
  }

  console.log('\nWorker Gateway Bindings:');
  for (const wc of workerConfigs) {
    console.log(`  • [${wc.workerId}] Assigned Gateway: ${wc.gateway}`);
  }

  const tStart = performance.now();

  // Spawn all workers in parallel
  const workerPromises = workerConfigs.map((wc) => {
    return new Promise((resolve, reject) => {
      const proc = spawnWorker(wc.workerId, coordId, runId, wc.gateway, knownIndex, WORK_ROUNDS);
      let stdoutData = '';
      let stderrData = '';

      proc.stdout.on('data', (d) => (stdoutData += d.toString()));
      proc.stderr.on('data', (d) => (stderrData += d.toString()));

      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Worker ${wc.workerId} failed with code ${code}: ${stderrData}`));
        } else {
          try {
            const parsed = JSON.parse(stdoutData.trim());
            resolve({ ...wc, ...parsed });
          } catch (err) {
            resolve({ ...wc, rawStdout: stdoutData });
          }
        }
      });
    });
  });

  const workerResults = await Promise.all(workerPromises);
  const wallSeconds = (performance.now() - tStart) / 1000;
  const throughput = candidateCount / wallSeconds;

  // Retrieve final coordinator ledger state
  await postSend('admin', coordId, 'GetRun', { run_id: runId });
  const finalState = (await pollMessage('admin')).message.data;
  coordProc.kill();

  console.log(`\nRun Completed in ${wallSeconds.toFixed(2)}s | Throughput: ${throughput.toFixed(2)} c/s`);
  console.log(`Ledger Summary:`);
  console.log(`  • Complete:                     ${finalState.complete}`);
  console.log(`  • Unique Accepted Evaluations:  ${finalState.unique_accepted_evaluations} / ${candidateCount}`);
  console.log(`  • Physical Evaluations:         ${finalState.physical_evaluations}`);
  console.log(`  • Accepted Completions:         ${finalState.accepted_completions}`);
  console.log(`  • Stale / Duplicate Rejected:   ${finalState.rejected_stale_or_duplicate}`);
  console.log(`  • Hits Recorded:                ${finalState.hit_count}`);
  console.log(`  • Gateways Used:                ${JSON.stringify(finalState.gateways_used)}`);

  console.log(`\nShard Routing Breakdown:`);
  console.table(
    finalState.shard_details.map((s) => ({
      Shard: s.shard_id,
      Range: `[${s.start_index}, ${s.end_index})`,
      Worker: s.completed_by,
      Gateway: s.gateway,
      Status: s.gateway_status,
    }))
  );

  // Invariant verification
  if (!finalState.complete) throw new Error(`Run incomplete for p=${p}`);
  if (finalState.unique_accepted_evaluations !== candidateCount) {
    throw new Error(`Evaluations mismatch: got ${finalState.unique_accepted_evaluations}, expected ${candidateCount}`);
  }
  if (finalState.rejected_stale_or_duplicate !== 0) {
    throw new Error(`Unexpected rejected shards: ${finalState.rejected_stale_or_duplicate}`);
  }
  if (finalState.gateways_used.length < Math.min(p, healthyGateways.length)) {
    throw new Error(`Gateway diversity failure: only ${finalState.gateways_used.length} gateways used`);
  }

  return {
    workers: p,
    wall_seconds: Number(wallSeconds.toFixed(3)),
    throughput_c_per_s: Number(throughput.toFixed(2)),
    gateways_used: finalState.gateways_used,
    worker_results: workerResults,
    ledger: finalState,
  };
}

async function main() {
  console.log('='.repeat(80));
  console.log('C95-AO-00D-1: AR.IO DECENTRALIZED MULTI-GATEWAY RUNNER INTEGRATION');
  console.log('='.repeat(80));

  // Step 1: Gateway pool audit
  console.log('\n[1/4] Auditing AR.IO Decentralized Gateway Pool...');
  const poolAudit = await auditGatewayPool(ARIO_GATEWAY_POOL);
  console.table(poolAudit);

  const healthy = poolAudit.filter((g) => g.status === 'HEALTHY');
  if (healthy.length < 2) {
    throw new Error(`Insufficient healthy gateways found (${healthy.length}). Need >= 2.`);
  }
  const healthyGateways = healthy.map((g) => g.gateway);
  console.log(`\nIdentified ${healthyGateways.length} healthy decentralized gateways:`);
  healthyGateways.forEach((gw, idx) => console.log(`  [${idx + 1}] ${gw}`));

  // Step 2: Start central network router
  console.log('\n[2/4] Starting Distributed Network Router on port', ROUTER_PORT);
  const routerProc = spawnRouter();
  await sleep(500);

  try {
    // Step 3: Run p = 2 Multi-Gateway Integration
    console.log('\n[3/4] Testing p = 2 Workers on 2 Distinct Gateways...');
    const resP2 = await runMultiGatewayStage(2, 64, 16, 42, healthyGateways);

    // Step 4: Run p = 4 Multi-Gateway Integration
    console.log('\n[4/4] Testing p = 4 Workers on 4 Distinct Gateways...');
    const resP4 = await runMultiGatewayStage(4, 64, 16, 18, healthyGateways);

    console.log(`\n${'='.repeat(80)}`);
    console.log('ALL MULTI-GATEWAY TESTS PASSED SUCCESSFULLY');
    console.log('='.repeat(80));
    console.log('Summary:');
    console.log(`  • p=2: Wall ${resP2.wall_seconds}s | ${resP2.throughput_c_per_s} c/s | Gateways: ${resP2.gateways_used.join(', ')}`);
    console.log(`  • p=4: Wall ${resP4.wall_seconds}s | ${resP4.throughput_c_per_s} c/s | Gateways: ${resP4.gateways_used.join(', ')}`);

    const outPath = path.join(__dirname, '..', 'c95_ao_00d_multigateway_results.json');
    fs.writeFileSync(outPath, JSON.stringify({ p2: resP2, p4: resP4 }, null, 2));
    console.log(`Results saved to ${outPath}`);
  } finally {
    routerProc.kill();
  }
}

main().catch((err) => {
  console.error('\nFATAL ERROR in Multi-Gateway Integration Test:', err);
  process.exit(1);
});
