#!/usr/bin/env node
/**
 * Reference/local integration host for Lab C Rust/WASM search kernel.
 *
 * Invokes lab_c_ao_worker.wasm via Node WebAssembly engine.
 * Reads binary output conforming to ShardOutputAbi.
 * Emits strict JSON envelope for AO worker consumption.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function toHex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

export async function createWasmRunner(wasmPath = path.join(__dirname, 'lab_c_ao_worker.wasm')) {
  const wasmBuffer = fs.readFileSync(wasmPath);
  const wasmModule = await WebAssembly.compile(wasmBuffer);

  return async function executeShard(start, end, knownIndex, runId, workRounds = 0) {
    const instance = await WebAssembly.instantiate(wasmModule, {});
    const {
      memory,
      alloc_bytes,
      free_bytes,
      run_shard_calibrated_abi,
      run_shard_abi,
    } = instance.exports;

    const runIdBytes = Buffer.from(runId, 'utf8');
    let runIdPtr = 0;
    if (runIdBytes.length > 0) {
      runIdPtr = alloc_bytes(runIdBytes.length);
      const memView = new Uint8Array(memory.buffer, runIdPtr, runIdBytes.length);
      memView.set(runIdBytes);
    }

    const startBig = BigInt(start);
    const endBig = BigInt(end);
    const knownBig = BigInt(knownIndex);
    const rounds = Number(workRounds) || 0;

    const fn = run_shard_calibrated_abi || run_shard_abi;
    const outPtr = run_shard_calibrated_abi
      ? run_shard_calibrated_abi(startBig, endBig, knownBig, rounds, runIdPtr, runIdBytes.length)
      : run_shard_abi(startBig, endBig, knownBig, runIdPtr, runIdBytes.length);

    const memBuffer = memory.buffer;
    const dataView = new DataView(memBuffer, outPtr, 88);

    const tested = Number(dataView.getBigUint64(0, true));
    const hasHit = dataView.getUint8(8) === 1;
    const hitIndex = Number(dataView.getBigUint64(16, true));

    const hitCommitmentBytes = new Uint8Array(memBuffer, outPtr + 24, 32);
    const hitCommitment = hasHit ? toHex(hitCommitmentBytes) : null;

    const resultDigestBytes = new Uint8Array(memBuffer, outPtr + 56, 32);
    const resultDigest = toHex(resultDigestBytes);

    if (runIdPtr !== 0) {
      free_bytes(runIdPtr, runIdBytes.length);
    }

    return {
      tested,
      has_hit: hasHit,
      hit_index: hasHit ? hitIndex : null,
      hit_commitment: hitCommitment,
      result_digest: resultDigest,
    };
  };
}

// CLI usage: node wasm_runner.mjs <start> <end> <known_index> <run_id> [work_rounds] [wasm_path]
if (process.argv[1] && process.argv[1].endsWith('wasm_runner.mjs')) {
  const args = process.argv.slice(2);
  if (args.length < 4) {
    console.error('Usage: wasm_runner.mjs <start> <end> <known_index> <run_id> [work_rounds] [wasm_path]');
    process.exit(2);
  }

  const [start, end, knownIndex, runId, workRounds = 0, wasmPath] = args;
  try {
    const runner = await createWasmRunner(wasmPath);
    const res = await runner(Number(start), Number(end), Number(knownIndex), runId, Number(workRounds));
    console.log(JSON.stringify(res));
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
