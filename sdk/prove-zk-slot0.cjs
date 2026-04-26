const { execFileSync } = require("child_process");
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("fs");
const { join, resolve } = require("path");
const { createZkPredicateJob, createZkProofReceipt } = require("../core/zk-pipeline");
const { hashState } = require("../core/hash");
const { createSlot0ZkInput } = require("../core/slot0-zk-input");
const { decodeSlot0 } = require("../core/uniswap-v3");

const repoRoot = resolve(__dirname, "..");
const artifactDir = join(repoRoot, ".paxiom-runtime", "zk", "uniswap_v3_slot0");
const snarkjs = join(repoRoot, "node_modules", ".bin", "snarkjs");
const wasm = join(artifactDir, "uniswap_v3_slot0.wasm");
const zkey = join(artifactDir, "uniswap_v3_slot0_final.zkey");
const vkey = join(artifactDir, "verification_key.json");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--slot0") args.slot0 = argv[++i];
    else if (arg.startsWith("--slot0=")) args.slot0 = arg.slice("--slot0=".length);
    else if (arg === "--subject") args.subject = argv[++i];
    else if (arg.startsWith("--subject=")) args.subject = arg.slice("--subject=".length);
    else if (arg === "--block") args.block_number = Number(argv[++i]);
    else if (arg.startsWith("--block=")) args.block_number = Number(arg.slice("--block=".length));
    else if (arg === "--state-root") args.state_root = argv[++i];
    else if (arg.startsWith("--state-root=")) args.state_root = arg.slice("--state-root=".length);
    else if (arg === "--out") args.out = argv[++i];
    else if (arg.startsWith("--out=")) args.out = arg.slice("--out=".length);
  }
  return args;
}

function requireArtifact(file) {
  if (!existsSync(file)) {
    throw new Error(`${file} not found. Run npm run zk:setup:slot0 first.`);
  }
}

function run(cmd, args) {
  execFileSync(cmd, args, { cwd: repoRoot, stdio: "inherit" });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.slot0 || !args.subject || !Number.isInteger(args.block_number) || !args.state_root) {
    console.error("Usage: npm run zk:prove:slot0 -- --slot0 <hex> --subject <subject> --block <n> --state-root <root>");
    process.exit(1);
  }

  for (const file of [wasm, zkey, vkey]) requireArtifact(file);

  const outDir = join(repoRoot, ".paxiom-runtime", "zk", "proofs");
  mkdirSync(outDir, { recursive: true });

  const input = createSlot0ZkInput(args.slot0);
  const inputPath = join(outDir, "slot0-input.json");
  const proofPath = join(outDir, "slot0-proof.json");
  const publicPath = join(outDir, "slot0-public.json");
  writeFileSync(inputPath, `${JSON.stringify(input, null, 2)}\n`);

  run(snarkjs, ["groth16", "fullprove", inputPath, wasm, zkey, proofPath, publicPath]);
  run(snarkjs, ["groth16", "verify", vkey, publicPath, proofPath]);

  const proof = JSON.parse(readFileSync(proofPath, "utf8"));
  const publicSignals = JSON.parse(readFileSync(publicPath, "utf8"));
  const decoded = decodeSlot0(args.slot0);
  const proofHash = hashState({ proof, publicSignals });
  const job = createZkPredicateJob({
    predicate: "uniswap_v3_slot0",
    subject: args.subject,
    block_number: args.block_number,
    state_root: args.state_root,
    witness_commitment: hashState({ slot0: args.slot0, decoded }),
    target_proof_system: "groth16-bn128-uniswap-v3-slot0-dev",
    public_inputs: {
      packed: input.packed,
      sqrtPriceX96: input.sqrtPriceX96,
      tickRaw: input.tickRaw,
      observationIndex: input.observationIndex,
      observationCardinality: input.observationCardinality,
      observationCardinalityNext: input.observationCardinalityNext,
      feeProtocol: input.feeProtocol,
      unlockedByte: input.unlockedByte
    }
  });
  const receipt = createZkProofReceipt({
    job,
    proof_system: "groth16-bn128-uniswap-v3-slot0-dev",
    proof_hash: proofHash,
    verifier_id: "uniswap-v3-slot0-dev-v1",
    public_outputs: {
      ...decoded,
      publicSignals
    }
  });

  const bundle = {
    schema: "paxiom.zk_predicate_proof.v1",
    job,
    receipt,
    proof,
    publicSignals,
    verification_key_path: vkey
  };

  const outputPath = args.out ? resolve(args.out) : join(outDir, "slot0-proof-bundle.json");
  writeFileSync(outputPath, `${JSON.stringify(bundle, null, 2)}\n`);
  console.log(JSON.stringify({
    status: "ok",
    output: outputPath,
    job_id: job.job_id,
    receipt_commitment: receipt.commitment,
    proof_hash: proofHash,
    predicate: receipt.predicate,
    block_number: receipt.block_number
  }, null, 2));
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
