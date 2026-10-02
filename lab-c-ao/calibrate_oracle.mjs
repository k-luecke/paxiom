import { createWasmRunner } from './wasm_runner.mjs';

const runner = await createWasmRunner('./lab_c_ao_worker.wasm');

const testRounds = [180000, 190000, 200000, 210000, 220000];

for (const r of testRounds) {
  const count = 10;
  const t0 = performance.now();
  await runner(0, count, -1, "calibration-run", r);
  const elapsedMs = performance.now() - t0;
  const msPerCand = elapsedMs / count;
  const candPerSec = 1000 / msPerCand;
  console.log(`  r = ${r}: ${msPerCand.toFixed(2)} ms/candidate | ${candPerSec.toFixed(2)} candidates/s`);
}
