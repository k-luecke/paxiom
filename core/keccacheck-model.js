const { hashCommitment } = require("./proof-corpus");

const KECCACHECK_BENCHMARKS = Object.freeze([
  { instances: 1, constraints: 638682, proving_seconds: 1.435 },
  { instances: 2, constraints: 685030, proving_seconds: 1.572 },
  { instances: 4, constraints: 734833, proving_seconds: 1.788 },
  { instances: 8, constraints: 791597, proving_seconds: 1.757 },
  { instances: 16, constraints: 862237, proving_seconds: 1.918 },
  { instances: 32, constraints: 960572, proving_seconds: 2.092 },
  { instances: 64, constraints: 1114403, proving_seconds: 2.846 },
  { instances: 128, constraints: 1379176, proving_seconds: 3.311 },
  { instances: 256, constraints: 1866338, proving_seconds: 4.122 },
  { instances: 512, constraints: 2796713, proving_seconds: 6.587 },
  { instances: 1024, constraints: 4614574, proving_seconds: 11.786 },
  { instances: 2048, constraints: 8207357, proving_seconds: 19.936 },
  { instances: 4096, constraints: 15350034, proving_seconds: 43.263 },
  { instances: 8192, constraints: 29592549, proving_seconds: 124.641 },
  { instances: 16384, constraints: 58034640, proving_seconds: 400.541 }
]);

const EXPANDER_KECCAK_F_PER_SECOND = 4500;
const EXPANDER_MEMORY_MB_PER_KECCAK = 16;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function nextPowerOfTwo(value) {
  assert(Number.isInteger(value) && value > 0, "value must be a positive integer");
  let out = 1;
  while (out < value) out *= 2;
  return out;
}

function log2Integer(value) {
  assert(Number.isInteger(value) && value > 0, "value must be a positive integer");
  return Math.log2(value);
}

function benchmarkForBatch(instances) {
  const padded = nextPowerOfTwo(instances);
  const exact = KECCACHECK_BENCHMARKS.find(item => item.instances === padded);
  if (exact) return exact;

  const last = KECCACHECK_BENCHMARKS[KECCACHECK_BENCHMARKS.length - 1];
  const asymptoticConstraints = 3456 * padded;
  return {
    instances: padded,
    constraints: Math.max(asymptoticConstraints, Math.ceil(last.constraints * (padded / last.instances))),
    proving_seconds: Number((last.proving_seconds * (padded / last.instances)).toFixed(3)),
    extrapolated: true
  };
}

function keccakPermutationsForBytes(byteLength) {
  assert(Number.isInteger(byteLength) && byteLength >= 0, "byteLength must be a non-negative integer");
  // Keccak-256 has a 1088-bit, 136-byte rate. Padding requires one extra block when the
  // input exactly fills a block.
  return Math.floor(byteLength / 136) + 1;
}

function keccakTasksForInclusionWitness(witness) {
  assert(witness && witness.schema === "paxiom.ethereum_inclusion_witness.v1", "Expected inclusion witness");

  const nodeTasks = [
    ...(witness.account_proof_nodes || []).map(node => ({ group: "account_node", ...node })),
    ...(witness.storage_proof_nodes || []).map(node => ({ group: "storage_node", ...node }))
  ].map(node => ({
    group: node.group,
    index: node.index,
    byte_length: node.byte_length,
    keccak: node.keccak,
    permutations: keccakPermutationsForBytes(node.byte_length)
  }));

  const keyTasks = [
    { group: "account_key", index: 0, byte_length: 20, permutations: keccakPermutationsForBytes(20) },
    { group: "storage_key", index: 0, byte_length: 32, permutations: keccakPermutationsForBytes(32) }
  ];

  return [...keyTasks, ...nodeTasks];
}

function estimateKeccacheckBatch(taskCount) {
  assert(Number.isInteger(taskCount) && taskCount > 0, "taskCount must be a positive integer");
  const padded_instances = nextPowerOfTwo(taskCount);
  const benchmark = benchmarkForBatch(padded_instances);

  return {
    requested_instances: taskCount,
    padded_instances,
    num_variables: 6 + log2Integer(padded_instances),
    padding_instances: padded_instances - taskCount,
    estimated_constraints: benchmark.constraints,
    estimated_proving_seconds: benchmark.proving_seconds,
    estimated_constraints_per_requested_instance: Math.ceil(benchmark.constraints / taskCount),
    estimated_seconds_per_requested_instance: Number((benchmark.proving_seconds / taskCount).toFixed(6)),
    source: benchmark.extrapolated ? "keccacheck paper extrapolation" : "keccacheck paper benchmark table"
  };
}

function estimateExpanderBatch(taskCount) {
  assert(Number.isInteger(taskCount) && taskCount > 0, "taskCount must be a positive integer");
  return {
    requested_instances: taskCount,
    estimated_proving_seconds: Number((taskCount / EXPANDER_KECCAK_F_PER_SECOND).toFixed(6)),
    estimated_peak_memory_mb: taskCount * EXPANDER_MEMORY_MB_PER_KECCAK,
    keccak_f_per_second: EXPANDER_KECCAK_F_PER_SECOND,
    memory_mb_per_keccak: EXPANDER_MEMORY_MB_PER_KECCAK,
    source: "Polyhedra Expander blog benchmark"
  };
}

function compareKeccakBackends(taskCount) {
  const keccacheck = estimateKeccacheckBatch(taskCount);
  const expander = estimateExpanderBatch(taskCount);
  return {
    requested_instances: taskCount,
    keccacheck,
    expander,
    expander_speedup_vs_keccacheck_estimate: Number(
      (keccacheck.estimated_proving_seconds / expander.estimated_proving_seconds).toFixed(2)
    ),
    caveat: "Expander estimate is throughput-only from a public blog benchmark; integration, proof format, recursion, and license boundaries still need engineering validation."
  };
}

function planKeccacheckForInclusionWitness(witness, options = {}) {
  const maxBatchSize = options.maxBatchSize || 1024;
  assert(Number.isInteger(maxBatchSize) && maxBatchSize > 0, "maxBatchSize must be a positive integer");

  const tasks = keccakTasksForInclusionWitness(witness);
  const totalPermutations = tasks.reduce((sum, task) => sum + task.permutations, 0);
  const batches = [];
  const backendComparisons = [];

  let remaining = totalPermutations;
  while (remaining > 0) {
    const requested = Math.min(remaining, maxBatchSize);
    batches.push(estimateKeccacheckBatch(requested));
    backendComparisons.push(compareKeccakBackends(requested));
    remaining -= requested;
  }

  const plan = {
    kind: "PAXIOM_KECCACHECK_BATCH_PLAN",
    witness_commitment: witness.commitment || null,
    target: witness.target || null,
    total_keccak_permutations: totalPermutations,
    task_count: tasks.length,
    max_batch_size: maxBatchSize,
    batches,
    backend_comparisons: backendComparisons,
    ao_strategy: {
      assignment_unit: "keccak permutation batch",
      recommended_min_batch: 16,
      recommended_live_batch: 1024,
      publish_boundary: "subscriber feed can publish after local verification; AO receipt posting should run in parallel"
    }
  };

  return {
    ...plan,
    commitment: hashCommitment("PAXIOM_KECCACHECK_BATCH_PLAN", plan)
  };
}

module.exports = {
  EXPANDER_KECCAK_F_PER_SECOND,
  EXPANDER_MEMORY_MB_PER_KECCAK,
  KECCACHECK_BENCHMARKS,
  compareKeccakBackends,
  estimateKeccacheckBatch,
  estimateExpanderBatch,
  keccakPermutationsForBytes,
  keccakTasksForInclusionWitness,
  planKeccacheckForInclusionWitness
};
