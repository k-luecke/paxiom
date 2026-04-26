const { existsSync, readFileSync, writeFileSync, mkdirSync } = require("fs");
const { join, resolve } = require("path");
const { planKeccacheckForInclusionWitness } = require("../core/keccacheck-model");

const repoRoot = resolve(__dirname, "..");

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find(value => value.startsWith(prefix));
  if (!found) return fallback;
  return found.slice(prefix.length);
}

function loadJson(path) {
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  return JSON.parse(readFileSync(resolved, "utf8"));
}

function planKeccacheckBatch(options = {}) {
  const witnessPath =
    options.witness ||
    arg("witness", join(repoRoot, ".paxiom-runtime", "ethereum-inclusion-witness.json"));
  const out =
    options.out ||
    arg("out", join(repoRoot, ".paxiom-runtime", "keccacheck-batch-plan.json"));
  const maxBatchSize = Number(options.maxBatchSize || arg("max-batch", "1024"));

  const witness = loadJson(witnessPath);
  const plan = planKeccacheckForInclusionWitness(witness, { maxBatchSize });

  mkdirSync(resolve(out, ".."), { recursive: true });
  writeFileSync(out, `${JSON.stringify(plan, null, 2)}\n`);

  return { plan, out };
}

if (require.main === module) {
  try {
    const { plan, out } = planKeccacheckBatch();
    const firstBatch = plan.batches[0];
    console.log(JSON.stringify({
      status: "ok",
      out,
      commitment: plan.commitment,
      total_keccak_permutations: plan.total_keccak_permutations,
      task_count: plan.task_count,
      batches: plan.batches.length,
      first_batch_requested_instances: firstBatch?.requested_instances || 0,
      first_batch_padded_instances: firstBatch?.padded_instances || 0,
      first_batch_estimated_constraints: firstBatch?.estimated_constraints || 0,
      first_batch_estimated_proving_seconds: firstBatch?.estimated_proving_seconds || 0,
      first_batch_expander_estimated_seconds:
        plan.backend_comparisons[0]?.expander?.estimated_proving_seconds || 0,
      first_batch_expander_speedup:
        plan.backend_comparisons[0]?.expander_speedup_vs_keccacheck_estimate || 0,
      source: firstBatch?.source || null
    }, null, 2));
  } catch (err) {
    console.error(err.stack || err.message);
    process.exit(1);
  }
}

module.exports = {
  planKeccacheckBatch
};
