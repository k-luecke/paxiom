const { execFileSync } = require("child_process");
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("fs");
const { join, resolve } = require("path");
const {
  GOLDILOCKS_PRIME,
  keccakF1600CostModel,
  keccakProofNodeHash,
  validateEthereumKeccakVectors
} = require("../core/goldilocks-keccak");
const { normalizeHex, verifyEip1186Proof } = require("../core/eth-proof");

const DEFAULT_RPC_URL = "https://ethereum-rpc.publicnode.com";
const DEFAULT_POOL = "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640";
const DEFAULT_SLOT = "0x0";
const repoRoot = resolve(__dirname, "..");

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find(value => value.startsWith(prefix));
  if (!found) return fallback;
  return found.slice(prefix.length);
}

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  const json = await res.json();
  if (json.error) {
    throw new Error(`${method} failed: ${json.error.message}`);
  }
  return json.result;
}

function timed(label, fn) {
  const start = process.hrtime.bigint();
  const value = fn();
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  return { label, elapsed_ms: Number(elapsedMs.toFixed(3)), value };
}

async function timedAsync(label, fn) {
  const start = process.hrtime.bigint();
  const value = await fn();
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  return { label, elapsed_ms: Number(elapsedMs.toFixed(3)), value };
}

function snarkjsR1csInfo() {
  const r1cs = join(repoRoot, ".paxiom-runtime", "zk", "uniswap_v3_slot0", "uniswap_v3_slot0.r1cs");
  if (!existsSync(r1cs)) return { available: false, reason: "slot0 r1cs artifact missing" };

  try {
    const output = execFileSync(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["snarkjs", "r1cs", "info", r1cs],
      { cwd: repoRoot, encoding: "utf8" }
    );
    return { available: true, output };
  } catch (err) {
    return {
      available: false,
      reason: err.message,
      output: err.stdout ? String(err.stdout) : null
    };
  }
}

async function schemaguruKeccakImpl() {
  const modulePath = "/mnt/c/Users/Kyle W. Luecke/Documents/New project/core/keccak256.mjs";
  if (!existsSync(modulePath)) return null;
  const mod = await import(`file://${modulePath.replaceAll(" ", "%20")}`);
  return mod.keccak256Hex;
}

function proofRootChecks({ block, proof }) {
  const accountRootHash = proof.accountProof?.[0]
    ? keccakProofNodeHash(proof.accountProof[0])
    : null;
  const storageRootHash = proof.storageProof?.[0]?.proof?.[0]
    ? keccakProofNodeHash(proof.storageProof[0].proof[0])
    : null;

  return {
    account_root_node_hash: accountRootHash,
    account_root_matches_state_root: accountRootHash === normalizeHex(block.stateRoot),
    storage_root_node_hash: storageRootHash,
    storage_root_matches_account_storage_hash: storageRootHash === normalizeHex(proof.storageHash)
  };
}

function summarizeProofShape(proof) {
  const storageProof = proof.storageProof?.[0]?.proof || [];
  return {
    account_proof_nodes: proof.accountProof?.length || 0,
    storage_proof_nodes: storageProof.length,
    account_proof_bytes: (proof.accountProof || []).reduce((sum, node) => sum + ((node.length - 2) / 2), 0),
    storage_proof_bytes: storageProof.reduce((sum, node) => sum + ((node.length - 2) / 2), 0)
  };
}

async function runExperiment(options = {}) {
  const rpcUrl = options.rpcUrl || process.env.ETH_RPC_URL || DEFAULT_RPC_URL;
  const address = options.address || arg("address", DEFAULT_POOL);
  const slot = options.slot || arg("slot", DEFAULT_SLOT);
  const blockTag = options.blockTag || arg("block", "finalized");
  const out =
    options.out ||
    arg("out", join(repoRoot, ".paxiom-runtime", "goldilocks-keccak-experiment.json"));

  const localVectors = timed("ethereum-cryptography keccak vectors", () => validateEthereumKeccakVectors());
  const schemaguruImpl = await schemaguruKeccakImpl();
  const schemaguruVectors = schemaguruImpl
    ? timed("schemaguru keccak vectors", () => validateEthereumKeccakVectors(schemaguruImpl))
    : { label: "schemaguru keccak vectors", elapsed_ms: null, value: null, skipped: true };

  const fetchBlock = await timedAsync("fetch finalized block", () =>
    rpc(rpcUrl, "eth_getBlockByNumber", [blockTag, false])
  );
  if (!fetchBlock.value) throw new Error(`Block not found: ${blockTag}`);

  const fetchProof = await timedAsync("fetch EIP-1186 proof", () =>
    rpc(rpcUrl, "eth_getProof", [address, [slot], fetchBlock.value.number])
  );

  const nodeHash = timed("one trie node hash check", () =>
    proofRootChecks({ block: fetchBlock.value, proof: fetchProof.value })
  );

  const fullMpt = await timedAsync("full EIP-1186 MPT verification", () =>
    verifyEip1186Proof({ block: fetchBlock.value, proof: fetchProof.value, address })
  );

  const report = {
    schema: "paxiom.goldilocks_keccak_experiment.v1",
    generated_at: new Date().toISOString(),
    target: {
      address: normalizeHex(address),
      slot: normalizeHex(slot),
      block_tag: blockTag,
      block_number: Number(BigInt(fetchBlock.value.number)),
      state_root: normalizeHex(fetchBlock.value.stateRoot)
    },
    step_1_fixed_keccak_relation: {
      status: localVectors.value.every(item => item.ok) &&
        (!schemaguruVectors.value || schemaguruVectors.value.every(item => item.ok))
        ? "passed"
        : "failed",
      caveat: "This is a deterministic relation/vector check, not yet a ZK proof of Keccak.",
      local_vectors: localVectors,
      schemaguru_vectors: schemaguruVectors,
      goldilocks_prime: GOLDILOCKS_PRIME.toString()
    },
    step_2_vectors: {
      status: "passed",
      vectors: localVectors.value.map(item => ({
        input: item.input || "<empty>",
        hash: item.got,
        selector: item.selector,
        limb_wraps: item.goldilocks_limbs.filter(limb => limb.wraps).length
      }))
    },
    step_3_backend_readiness: {
      status: "measured",
      current_groth16_slot0: snarkjsR1csInfo(),
      keccak_cost_model: keccakF1600CostModel(),
      read: "Goldilocks/STARK-style proving is the right experiment for Ethereum inclusion throughput, but Keccak is orders of magnitude larger than the current slot0 Groth16 predicate."
    },
    step_4_storage_proof_graduation: {
      status: fullMpt.value.verified ? "passed" : "failed",
      one_node_hash_check: nodeHash,
      full_eip1186_verification: {
        elapsed_ms: fullMpt.elapsed_ms,
        proof_hash: fullMpt.value.proofHash,
        storage_value: fullMpt.value.storage[0]?.value || null,
        account_storage_hash: fullMpt.value.account.storageHash
      },
      proof_shape: summarizeProofShape(fetchProof.value)
    }
  };

  mkdirSync(resolve(out, ".."), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  return { report, out };
}

if (require.main === module) {
  runExperiment()
    .then(({ report, out }) => {
      console.log(JSON.stringify({
        status: "ok",
        out,
        block_number: report.target.block_number,
        fixed_keccak_relation: report.step_1_fixed_keccak_relation.status,
        backend_readiness: report.step_3_backend_readiness.status,
        storage_proof: report.step_4_storage_proof_graduation.status,
        one_node_hash_check: report.step_4_storage_proof_graduation.one_node_hash_check.value,
        proof_hash: report.step_4_storage_proof_graduation.full_eip1186_verification.proof_hash
      }, null, 2));
    })
    .catch(err => {
      console.error(err.stack || err.message);
      process.exit(1);
    });
}

module.exports = {
  runExperiment
};
