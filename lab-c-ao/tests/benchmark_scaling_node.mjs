/**
 * High-performance In-Memory Multi-Worker Baseline Benchmark.
 *
 * Uses Node.js native WebAssembly compilation once and evaluates
 * scaling across 1, 2, 4, 8, 16, 32, 64 worker threads.
 *
 * Reports:
 * - wall_seconds
 * - throughput (candidates/sec)
 * - speedup and efficiency
 * - host bottleneck breakdown (pure wasm compute vs coordination/queue)
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = path.join(__dirname, '..', 'lab_c_ao_worker.wasm');

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ---------------------------------------------------------------------------
// Worker Thread Logic
// ---------------------------------------------------------------------------
if (!isMainThread) {
  const { wasmModule, knownIndex } = workerData;
  const instance = new WebAssembly.Instance(wasmModule, {});
  const { memory, alloc_bytes, free_bytes, run_shard_abi } = instance.exports;

  parentPort.on('message', (msg) => {
    if (msg.action === 'execute') {
      const { shardId, start, end, runId } = msg;
      const t0 = performance.now();

      const runIdBytes = Buffer.from(runId, 'utf8');
      let runIdPtr = 0;
      if (runIdBytes.length > 0) {
        runIdPtr = alloc_bytes(runIdBytes.length);
        new Uint8Array(memory.buffer, runIdPtr, runIdBytes.length).set(runIdBytes);
      }

      const outPtr = run_shard_abi(BigInt(start), BigInt(end), BigInt(knownIndex), runIdPtr, runIdBytes.length);
      const dataView = new DataView(memory.buffer, outPtr, 88);

      const tested = Number(dataView.getBigUint64(0, true));
      const hasHit = dataView.getUint8(8) === 1;
      const hitIndex = Number(dataView.getBigUint64(16, true));
      const hitCommitment = hasHit
        ? Buffer.from(new Uint8Array(memory.buffer, outPtr + 24, 32)).toString('hex')
        : null;
      const resultDigest = Buffer.from(new Uint8Array(memory.buffer, outPtr + 56, 32)).toString('hex');

      if (runIdPtr !== 0) {
        free_bytes(runIdPtr, runIdBytes.length);
      }

      const computeMs = performance.now() - t0;
      parentPort.postMessage({
        action: 'result',
        shardId,
        tested,
        hasHit,
        hitIndex,
        hitCommitment,
        resultDigest,
        computeMs,
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Main Coordinator Logic
// ---------------------------------------------------------------------------
if (isMainThread) {
  async function runBenchmarkSeries(candidateCount = 181440, shardSize = 4096) {
    const wasmBytes = fs.readFileSync(WASM_PATH);
    const kernelDigest = sha256Hex(wasmBytes);
    const familyDigest = sha256Hex(Buffer.from(`LAB-C-AO-SYNTHETIC-FAMILY-v1|N=${candidateCount}`));
    const knownIndex = 42109;

    console.log('='.repeat(80));
    console.log('C95-AO-00 — LOCAL_DISTRIBUTED_BASELINE (Node Multi-Thread WASM)');
    console.log(`Candidate Family Size: N = ${candidateCount} candidates, Shard Size = ${shardSize}`);
    console.log(`Kernel Digest: ${kernelDigest}`);
    console.log(`Family Digest: ${familyDigest}`);
    console.log('='.repeat(80));

    const wasmModule = await WebAssembly.compile(wasmBytes);
    const workerCounts = [1, 2, 4, 8, 16, 32, 64];
    const results = [];
    let t1Wall = null;

    for (const p of workerCounts) {
      const runId = `bench-threaded-p${p}-N${candidateCount}`;
      
      // Partition shards
      const shards = [];
      let i = 0;
      let sid = 0;
      while (i < candidateCount) {
        const e = Math.min(i + shardSize, candidateCount);
        sid++;
        shards.push({ shardId: sid, start: i, end: e, status: 'ready' });
        i = e;
      }

      // Spawn p workers
      const workers = [];
      for (let w = 0; w < p; w++) {
        workers.push(new Worker(fileURLToPath(import.meta.url), {
          workerData: { wasmModule, knownIndex },
        }));
      }

      const tStart = performance.now();
      let totalComputeMs = 0;
      let acceptedCompletions = 0;
      let totalTested = 0;
      let hitCommitmentFound = null;

      await new Promise((resolve) => {
        let shardCursor = 0;
        let activeWorkers = p;

        function assignNext(worker) {
          if (shardCursor < shards.length) {
            const shard = shards[shardCursor++];
            shard.status = 'leased';
            worker.postMessage({
              action: 'execute',
              shardId: shard.shardId,
              start: shard.start,
              end: shard.end,
              runId,
            });
          } else {
            worker.terminate();
            activeWorkers--;
            if (activeWorkers === 0) {
              resolve();
            }
          }
        }

        workers.forEach((worker) => {
          worker.on('message', (msg) => {
            if (msg.action === 'result') {
              totalComputeMs += msg.computeMs;
              acceptedCompletions++;
              totalTested += msg.tested;
              if (msg.hitCommitment) {
                hitCommitmentFound = msg.hitCommitment;
              }
              assignNext(worker);
            }
          });
          assignNext(worker);
        });
      });

      const wallSeconds = (performance.now() - tStart) / 1000;
      const workerSeconds = totalComputeMs / 1000;
      const coordOverhead = Math.max(0, wallSeconds - (workerSeconds / p));
      const candPerSec = candidateCount / wallSeconds;

      if (p === 1) {
        t1Wall = wallSeconds;
      }

      const speedup = Number((t1Wall / wallSeconds).toFixed(3));
      const efficiency = Number((speedup / p).toFixed(3));

      assert(totalTested === candidateCount, 'Tested count mismatch');
      assert(acceptedCompletions === shards.length, 'Incomplete run');

      const entry = {
        worker_count: p,
        candidate_count: candidateCount,
        shard_size: shardSize,
        shard_count: shards.length,
        wall_seconds: Number(wallSeconds.toFixed(4)),
        total_worker_seconds: Number(workerSeconds.toFixed(4)),
        coordinator_overhead_seconds: Number(coordOverhead.toFixed(4)),
        effective_candidates_per_sec: Number(candPerSec.toFixed(1)),
        speedup,
        efficiency,
        duplicate_accepted_work: 0,
        mathematical_candidates: candidateCount,
        unique_accepted_evaluations: totalTested,
        accepted_completions: acceptedCompletions,
        hit_commitment: hitCommitmentFound,
        kernel_digest: kernelDigest,
        family_digest: familyDigest,
      };

      results.push(entry);
      console.log(
        `  p=${String(p).padStart(2)}: Wall: ${wallSeconds.toFixed(4)}s | ` +
        `Worker Time: ${workerSeconds.toFixed(4)}s | ` +
        `Overhead: ${coordOverhead.toFixed(4)}s | ` +
        `Throughput: ${candPerSec.toFixed(0).padStart(8)} c/s | ` +
        `Speedup: ${speedup.toFixed(2).padStart(5)}x | ` +
        `Efficiency: ${efficiency.toFixed(2)}`
      );
    }

    const outPath = path.join(__dirname, '..', 'scaling_baseline_node_results.json');
    fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
    console.log(`\nThreaded scaling benchmark written to: ${outPath}`);
    return results;
  }

  function assert(condition, message) {
    if (!condition) {
      throw new Error(message);
    }
  }

  runBenchmarkSeries(181440, 4096).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
