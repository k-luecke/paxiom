const { mkdirSync, writeFileSync } = require("fs");
const { join, resolve } = require("path");
const { createEthereumInclusionWitness } = require("../core/eip1186-witness");
const { normalizeHex } = require("../core/eth-proof");

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

async function buildEthereumInclusionWitness(options = {}) {
  const rpcUrl = options.rpcUrl || process.env.ETH_RPC_URL || DEFAULT_RPC_URL;
  const address = options.address || arg("address", DEFAULT_POOL);
  const slot = options.slot || arg("slot", DEFAULT_SLOT);
  const blockTag = options.blockTag || arg("block", "finalized");
  const out =
    options.out ||
    arg("out", join(repoRoot, ".paxiom-runtime", "ethereum-inclusion-witness.json"));

  const block = await rpc(rpcUrl, "eth_getBlockByNumber", [blockTag, false]);
  if (!block) throw new Error(`Block not found: ${blockTag}`);

  const proof = await rpc(rpcUrl, "eth_getProof", [address, [slot], block.number]);
  const witness = await createEthereumInclusionWitness({ block, proof, slot });

  mkdirSync(resolve(out, ".."), { recursive: true });
  writeFileSync(out, `${JSON.stringify(witness, null, 2)}\n`);

  return { witness, out };
}

if (require.main === module) {
  buildEthereumInclusionWitness()
    .then(({ witness, out }) => {
      console.log(JSON.stringify({
        status: "ok",
        out,
        commitment: witness.commitment,
        block_number: witness.target.block_number,
        state_root: witness.target.state_root,
        address: normalizeHex(witness.target.address),
        storage_slot: normalizeHex(witness.target.storage_slot),
        storage_value: witness.target.storage_value,
        account_root_matches_state_root: witness.root_checks.account_root_matches_state_root,
        storage_root_matches_account_storage_hash: witness.root_checks.storage_root_matches_account_storage_hash,
        account_proof_nodes: witness.proof_shape.account_proof_nodes,
        storage_proof_nodes: witness.proof_shape.storage_proof_nodes,
        max_node_bytes: witness.proof_shape.max_node_bytes
      }, null, 2));
    })
    .catch(err => {
      console.error(err.stack || err.message);
      process.exit(1);
    });
}

module.exports = {
  buildEthereumInclusionWitness
};
