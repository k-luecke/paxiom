const { hashCommitment } = require("./proof-corpus");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function normalizeSubject(subject) {
  assert(typeof subject === "string" && subject.length > 0, "subject is required");
  return subject.toLowerCase();
}

function createZkPredicateJob(input) {
  assert(input && typeof input === "object", "ZK predicate job input must be an object");
  assert(typeof input.predicate === "string" && input.predicate.length > 0, "predicate is required");
  assert(Number.isInteger(input.block_number) && input.block_number >= 0, "block_number must be a non-negative integer");
  assert(typeof input.state_root === "string" && /^0x[0-9a-fA-F]{64}$/.test(input.state_root), "state_root must be a 32-byte hex root");

  const job = {
    kind: "ZK_PREDICATE_JOB",
    version: 1,
    chain: input.chain || "ethereum",
    predicate: input.predicate,
    subject: normalizeSubject(input.subject),
    block_number: input.block_number,
    state_root: input.state_root.toLowerCase(),
    witness_commitment: input.witness_commitment || null,
    public_inputs: input.public_inputs || {},
    target_proof_system: input.target_proof_system || "groth16-placeholder",
    priority: input.priority || "normal"
  };

  return {
    ...job,
    job_id: hashCommitment("ZK_PREDICATE_JOB", job)
  };
}

function assignJobToWorker(job, workerCount) {
  assert(job && job.kind === "ZK_PREDICATE_JOB", "Invalid ZK predicate job");
  assert(Number.isInteger(workerCount) && workerCount > 0, "workerCount must be positive");
  const shard = Number(BigInt(`0x${job.job_id.slice(0, 12)}`) % BigInt(workerCount));
  return {
    worker_id: `ao-zk-worker-${shard}`,
    shard,
    worker_count: workerCount
  };
}

function createAoDispatch(job, workerCount = 1) {
  const assignment = assignJobToWorker(job, workerCount);
  return {
    kind: "AO_ZK_JOB_DISPATCH",
    job_id: job.job_id,
    worker_id: assignment.worker_id,
    shard: assignment.shard,
    tags: [
      { name: "Action", value: "ProveZkPredicate" },
      { name: "Paxiom-Job-Id", value: job.job_id },
      { name: "Paxiom-Predicate", value: job.predicate },
      { name: "Paxiom-Subject", value: job.subject },
      { name: "Paxiom-Block", value: String(job.block_number) }
    ],
    data: job
  };
}

function createZkProofReceipt(input) {
  assert(input && typeof input === "object", "ZK proof receipt input must be an object");
  assert(input.job && input.job.kind === "ZK_PREDICATE_JOB", "job is required");
  assert(typeof input.proof_hash === "string" && input.proof_hash.length > 0, "proof_hash is required");

  const receipt = {
    kind: "ZK_PREDICATE_PROOF",
    version: 1,
    job_id: input.job.job_id,
    chain: input.job.chain,
    predicate: input.job.predicate,
    subject: input.job.subject,
    block_number: input.job.block_number,
    state_root: input.job.state_root,
    proof_system: input.proof_system || input.job.target_proof_system,
    proof_hash: input.proof_hash,
    verifier_id: input.verifier_id || null,
    public_outputs: input.public_outputs || {}
  };

  return {
    ...receipt,
    commitment: hashCommitment("ZK_PREDICATE_PROOF", receipt)
  };
}

function createRecursiveAggregationPlan(receipts, options = {}) {
  assert(Array.isArray(receipts) && receipts.length > 0, "At least one receipt is required");
  const sorted = receipts.slice().sort((a, b) => {
    if (a.block_number !== b.block_number) return a.block_number - b.block_number;
    return a.job_id.localeCompare(b.job_id);
  });
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const plan = {
    kind: "ZK_RECURSIVE_AGGREGATION_PLAN",
    version: 1,
    chain: first.chain,
    from_block: first.block_number,
    to_block: last.block_number,
    proof_system: options.proof_system || "recursive-snark-placeholder",
    aggregation_strategy: options.aggregation_strategy || "block-ordered-fold",
    receipt_commitments: sorted.map(receipt => receipt.commitment),
    public_inputs: options.public_inputs || {}
  };

  return {
    ...plan,
    commitment: hashCommitment("ZK_RECURSIVE_AGGREGATION_PLAN", plan)
  };
}

module.exports = {
  assignJobToWorker,
  createAoDispatch,
  createRecursiveAggregationPlan,
  createZkPredicateJob,
  createZkProofReceipt
};
