/**
 * Standalone Worker Daemon for Networked Distributed WASM Runner (C95-AO-00B / C95-AO-00D).
 *
 * Runs as an independent OS process with a unique Process ID.
 * Communicates with the Coordinator over the HTTP Router or HyperBEAM.
 * Binds to an assigned independent AR.IO decentralized gateway from the pool.
 * Executes the compiled Rust/WASM search kernel with calibrated expensive oracle rounds.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWasmRunner } from '../wasm_runner.mjs';
import { getGatewayForWorker } from './gateway_pool.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTER_URL = process.env.ROUTER_URL || 'http://127.0.0.1:8765';
const PROCESS_ID = process.env.PROCESS_ID || `worker-net-${process.pid}`;
const COORDINATOR_ID = process.env.COORDINATOR_ID || 'coord-net-01';
const RUN_ID = process.env.RUN_ID || 'test-run';
const WORK_ROUNDS = Number(process.env.WORK_ROUNDS || 200000);
const KNOWN_INDEX = Number(process.env.KNOWN_INDEX || -1);
const WASM_PATH = process.env.WASM_PATH || path.join(__dirname, '..', 'lab_c_ao_worker.wasm');
const GATEWAY_URL = process.env.GATEWAY_URL || getGatewayForWorker(PROCESS_ID);

async function postSend(target, action, data, retries = 5) {
  const payload = {
    from: PROCESS_ID,
    target,
    action,
    data,
  };
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${ROUTER_URL}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Connection': 'keep-alive' },
        body: JSON.stringify(payload),
      });
      return await res.json();
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, 100 * attempt));
    }
  }
}

async function pollNextMessage() {
  while (true) {
    try {
      const res = await fetch(`${ROUTER_URL}/poll/${PROCESS_ID}`, {
        headers: { 'Connection': 'keep-alive' },
      });
      const body = await res.json();
      if (body.ok && body.message) {
        return body.message;
      }
    } catch (err) {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}

async function verifyGatewayHealth(gwUrl) {
  try {
    const t0 = performance.now();
    const res = await fetch(`${gwUrl}/info`, { signal: AbortSignal.timeout(3000) });
    const ms = (performance.now() - t0).toFixed(1);
    if (res.ok) {
      return { ok: true, ms };
    }
  } catch (err) {}
  return { ok: false };
}

async function main() {
  const runner = await createWasmRunner(WASM_PATH);
  let completedShards = 0;
  let totalComputeMs = 0;

  // Verify assigned AR.IO gateway
  const gwHealth = await verifyGatewayHealth(GATEWAY_URL);

  while (true) {
    // 1. Request lease from coordinator
    await postSend(COORDINATOR_ID, 'LeaseShard', {
      run_id: RUN_ID,
      gateway: GATEWAY_URL,
    });

    // 2. Await response
    const msg = await pollNextMessage();
    if (msg.action === 'NoShard') {
      if (msg.data && msg.data.complete) {
        break;
      }
      await new Promise((r) => setTimeout(r, 300));
      continue;
    }
    if (msg.action !== 'ShardLease') {
      console.error(`[${PROCESS_ID}] Unexpected response:`, msg);
      break;
    }

    const shard = msg.data;
    const t0 = performance.now();

    // 3. Execute WASM search kernel with calibrated expensive oracle
    const wasmRes = await runner(
      shard.start_index,
      shard.end_index,
      KNOWN_INDEX,
      RUN_ID,
      WORK_ROUNDS
    );
    const duration = performance.now() - t0;
    totalComputeMs += duration;

    // 4. Secret quarantine
    for (const f of ['secret', 'private_key', 'seed', 'mnemonic']) {
      if (wasmRes[f]) {
        throw new Error(`Quarantine breach: forbidden field ${f} present!`);
      }
    }

    // 5. Submit completed shard result with gateway receipt
    const submitPayload = {
      run_id: RUN_ID,
      shard_id: shard.shard_id,
      lease_token: shard.lease_token,
      family_digest: shard.family_digest,
      kernel_digest: shard.kernel_digest,
      tested: wasmRes.tested,
      result_digest: wasmRes.result_digest,
      hit_commitment: wasmRes.hit_commitment,
      gateway: GATEWAY_URL,
      gateway_status: gwHealth.ok ? 'OK' : 'DEGRADED',
    };

    await postSend(COORDINATOR_ID, 'SubmitShard', submitPayload);
    const ack = await pollNextMessage();
    if (ack.action !== 'ShardAccepted') {
      console.error(`[${PROCESS_ID}] Shard ${shard.shard_id} not accepted:`, ack);
    } else {
      completedShards++;
    }
  }

  process.stdout.write(JSON.stringify({
    process_id: PROCESS_ID,
    gateway: GATEWAY_URL,
    shards_completed: completedShards,
    total_compute_ms: totalComputeMs,
  }));
  process.exit(0);
}

main().catch((err) => {
  console.error(`[${PROCESS_ID}] Fatal error:`, err);
  process.exit(1);
});
