const { createFactProof } = require("../core/proof-corpus");
const { normalizeHex, verifyEip1186Proof } = require("../core/eth-proof");

const DEFAULT_RPC_URL = "https://ethereum-rpc.publicnode.com";

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

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find(value => value.startsWith(prefix));
  if (!found) return fallback;
  return found.slice(prefix.length);
}

async function proveStorage(options = {}) {
  const rpcUrl = options.rpcUrl || process.env.ETH_RPC_URL || DEFAULT_RPC_URL;
  const address = options.address || arg("address");
  const slot = options.slot || arg("slot", "0x0");
  const blockTag = options.blockTag || arg("block", "latest");
  const corpusCommitment =
    options.corpusCommitment ||
    arg("corpus", process.env.PAXIOM_CORPUS_COMMITMENT || "local-unaggregated");

  if (!address) {
    throw new Error("Usage: npm run proof:storage -- --address=0x... [--slot=0x0] [--block=latest] [--corpus=...]");
  }

  const block = await rpc(rpcUrl, "eth_getBlockByNumber", [blockTag, false]);
  if (!block) throw new Error(`Block not found: ${blockTag}`);

  const proof = await rpc(rpcUrl, "eth_getProof", [address, [slot], block.number]);
  const verified = await verifyEip1186Proof({ block, proof });
  const storage = verified.storage[0];

  const fact = createFactProof({
    slot: Number(BigInt(block.number)),
    state_root: verified.stateRoot,
    predicate: "storage_equals",
    subject: `ethereum:${normalizeHex(address)}:${normalizeHex(slot)}`,
    value: storage.value,
    corpus_commitment: corpusCommitment,
    witness_hash: verified.proofHash,
    proof_hash: verified.proofHash,
    proof_system: "eip1186-mpt"
  });

  return {
    verified,
    fact
  };
}

if (require.main === module) {
  proveStorage()
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(err => {
      console.error(err.message);
      process.exit(1);
    });
}

module.exports = {
  proveStorage
};
