const { createFactProof, hashCommitment } = require("../core/proof-corpus");
const { decodeSlot0, estimatePriceFromTick } = require("../core/uniswap-v3");
const { normalizeHex } = require("../core/eth-proof");
const { proveStorage } = require("./prove-eth-storage.cjs");

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find(value => value.startsWith(prefix));
  if (!found) return fallback;
  return found.slice(prefix.length);
}

async function proveUniswapV3Slot0(options = {}) {
  const pool = options.pool || arg("pool");
  const blockTag = options.blockTag || arg("block", "finalized");
  const token0Decimals = Number(options.token0Decimals ?? arg("token0-decimals", "18"));
  const token1Decimals = Number(options.token1Decimals ?? arg("token1-decimals", "18"));
  const corpusCommitment =
    options.corpusCommitment ||
    arg("corpus", process.env.PAXIOM_CORPUS_COMMITMENT || "local-unaggregated");

  if (!pool) {
    throw new Error("Usage: npm run proof:uniswap-v3-slot0 -- --pool=0x... [--block=finalized]");
  }

  const storageProof = await proveStorage({
    rpcUrl: options.rpcUrl,
    address: pool,
    slot: "0x0",
    blockTag,
    corpusCommitment
  });

  const slot0 = decodeSlot0(storageProof.fact.value);
  const token1PerToken0 = estimatePriceFromTick(slot0.tick, token0Decimals, token1Decimals);
  const decodedHash = hashCommitment("UNISWAP_V3_SLOT0_DECODED", {
    pool: normalizeHex(pool),
    blockNumber: storageProof.verified.blockNumber,
    stateRoot: storageProof.verified.stateRoot,
    rawSlot0: storageProof.fact.value,
    slot0,
    token0Decimals,
    token1Decimals,
    token1PerToken0
  });

  const fact = createFactProof({
    slot: Number(storageProof.verified.blockNumber),
    state_root: storageProof.verified.stateRoot,
    predicate: "uniswap_v3_slot0",
    subject: `ethereum:${normalizeHex(pool)}:slot0`,
    value: {
      raw: storageProof.fact.value,
      decoded: slot0,
      token1PerToken0
    },
    corpus_commitment: corpusCommitment,
    witness_hash: storageProof.verified.proofHash,
    proof_hash: decodedHash,
    proof_system: "eip1186-mpt+uniswap-v3-slot0"
  });

  return {
    verified: storageProof.verified,
    storageFact: storageProof.fact,
    slot0,
    token1PerToken0,
    fact
  };
}

if (require.main === module) {
  proveUniswapV3Slot0()
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(err => {
      console.error(err.message);
      process.exit(1);
    });
}

module.exports = {
  proveUniswapV3Slot0
};
