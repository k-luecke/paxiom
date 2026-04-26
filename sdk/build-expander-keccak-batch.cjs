const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("fs");
const { join, resolve } = require("path");
const { createExpanderKeccakBatch } = require("../core/expander-keccak-batch");

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

function buildExpanderKeccakBatch(options = {}) {
  const witnessPath =
    options.witness ||
    arg("witness", join(repoRoot, ".paxiom-runtime", "ethereum-inclusion-witness.json"));
  const out =
    options.out ||
    arg("out", join(repoRoot, ".paxiom-runtime", "expander-keccak-batch.json"));

  const witness = loadJson(witnessPath);
  const batch = createExpanderKeccakBatch(witness);

  mkdirSync(resolve(out, ".."), { recursive: true });
  writeFileSync(out, `${JSON.stringify(batch, null, 2)}\n`);
  return { batch, out };
}

if (require.main === module) {
  try {
    const { batch, out } = buildExpanderKeccakBatch();
    console.log(JSON.stringify({
      status: "ok",
      out,
      commitment: batch.commitment,
      witness_commitment: batch.witness_commitment,
      task_count: batch.tasks.length,
      permutation_count: batch.permutation_count,
      backend_target: batch.backend_target,
      first_task: batch.tasks[0]?.id || null,
      last_task: batch.tasks[batch.tasks.length - 1]?.id || null
    }, null, 2));
  } catch (err) {
    console.error(err.stack || err.message);
    process.exit(1);
  }
}

module.exports = {
  buildExpanderKeccakBatch
};
