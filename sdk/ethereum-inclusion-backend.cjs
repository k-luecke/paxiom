const { existsSync, readFileSync } = require("fs");
const { resolve } = require("path");
const { hashCommitment } = require("../core/proof-corpus");
const { stableWitnessPayload } = require("../core/eip1186-witness");

const BACKENDS = Object.freeze({
  "mock-normalized": {
    kind: "mock-normalized",
    status: "available",
    proves_in_circuit: false,
    note: "Checks that the normalized witness has already been verified off-chain and emits a commitment for pipeline wiring."
  },
  "circom-keccak-mpt": {
    kind: "circom-keccak-mpt",
    status: "pending",
    proves_in_circuit: true,
    note: "Target for Keccak + RLP + MPT circuits. Requires vendored or locally configured circuits and trusted setup."
  },
  "goldilocks-stark": {
    kind: "goldilocks-stark",
    status: "research",
    proves_in_circuit: true,
    note: "Preferred throughput target for AO-parallel proving once Keccak/RLP/MPT AIR or lookup tables are selected."
  },
  "zkvm": {
    kind: "zkvm",
    status: "research",
    proves_in_circuit: true,
    note: "Can prove an Ethereum trie verifier program faster to implement, with higher per-proof overhead."
  }
});

function loadWitness(path) {
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    throw new Error(`Witness file not found: ${resolved}`);
  }
  return JSON.parse(readFileSync(resolved, "utf8"));
}

function assertUsableWitness(witness) {
  if (!witness || witness.schema !== "paxiom.ethereum_inclusion_witness.v1") {
    throw new Error("Expected paxiom.ethereum_inclusion_witness.v1 witness");
  }
  if (!witness.verified_offchain) {
    throw new Error("Witness has not been off-chain verified");
  }
  if (!witness.root_checks?.account_root_matches_state_root) {
    throw new Error("Account proof root does not match state root");
  }
  if (!witness.root_checks?.storage_root_matches_account_storage_hash) {
    throw new Error("Storage proof root does not match account storage hash");
  }
}

function proveEthereumInclusion(witness, options = {}) {
  const backendName = options.backend || process.env.PAXIOM_ETH_INCLUSION_BACKEND || "mock-normalized";
  const backend = BACKENDS[backendName];
  if (!backend) {
    throw new Error(`Unknown Ethereum inclusion backend: ${backendName}`);
  }

  assertUsableWitness(witness);

  if (backend.kind !== "mock-normalized") {
    throw new Error(
      `${backend.kind} is not wired yet. The witness is ready; next step is plugging Keccak/RLP/MPT constraints into this backend contract.`
    );
  }

  const publicInputs = {
    state_root: witness.public_inputs.state_root,
    address_hash: witness.public_inputs.address_hash,
    storage_root: witness.public_inputs.storage_root,
    storage_key_hash: witness.public_inputs.storage_key_hash,
    storage_value: witness.public_inputs.storage_value
  };
  const witnessCommitment = witness.commitment ||
    hashCommitment("ETHEREUM_INCLUSION_WITNESS", stableWitnessPayload(witness));

  return {
    kind: "ETHEREUM_INCLUSION_BACKEND_PROOF",
    backend: backend.kind,
    proves_in_circuit: backend.proves_in_circuit,
    verification_level: "offchain_mpt_verified_backend_scaffold",
    witness_commitment: witnessCommitment,
    public_inputs: publicInputs,
    proof_hash: hashCommitment("ETHEREUM_INCLUSION_BACKEND_PROOF", {
      backend: backend.kind,
      witness_commitment: witnessCommitment,
      public_inputs: publicInputs
    }),
    next_backend_targets: Object.values(BACKENDS)
      .filter(item => item.proves_in_circuit)
      .map(item => ({ backend: item.kind, status: item.status, note: item.note }))
  };
}

if (require.main === module) {
  const witnessArg = process.argv.find(value => value.startsWith("--witness="));
  const backendArg = process.argv.find(value => value.startsWith("--backend="));
  const witnessPath = witnessArg
    ? witnessArg.slice("--witness=".length)
    : resolve(__dirname, "..", ".paxiom-runtime", "ethereum-inclusion-witness.json");
  const backend = backendArg ? backendArg.slice("--backend=".length) : undefined;

  try {
    const proof = proveEthereumInclusion(loadWitness(witnessPath), { backend });
    console.log(JSON.stringify(proof, null, 2));
  } catch (err) {
    console.error(err.stack || err.message);
    process.exit(1);
  }
}

module.exports = {
  BACKENDS,
  assertUsableWitness,
  loadWitness,
  proveEthereumInclusion
};
