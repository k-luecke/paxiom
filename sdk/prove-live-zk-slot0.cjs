const { appendFeedItem, createFeedItem } = require("../feed/store");
const { normalizeHex } = require("../core/eth-proof");
const { proveUniswapV3Slot0 } = require("./prove-uniswap-v3-slot0.cjs");
const { proveSlot0Zk } = require("./prove-zk-slot0.cjs");

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find(value => value.startsWith(prefix));
  if (!found) return fallback;
  return found.slice(prefix.length);
}

async function proveLiveZkSlot0(options = {}) {
  const pool = options.pool || arg("pool");
  const blockTag = options.blockTag || arg("block", "finalized");
  const token0Decimals = Number(options.token0Decimals ?? arg("token0-decimals", "6"));
  const token1Decimals = Number(options.token1Decimals ?? arg("token1-decimals", "18"));
  const writeFeed = options.writeFeed ?? arg("write-feed", process.env.PAXIOM_WRITE_FEED || "true") !== "false";
  const out = options.out || arg("out");

  if (!pool) {
    throw new Error("Usage: npm run zk:live:slot0 -- --pool=0x... [--block=finalized]");
  }

  const mpt = await proveUniswapV3Slot0({
    pool,
    blockTag,
    token0Decimals,
    token1Decimals,
    corpusCommitment: options.corpusCommitment || "local-live-zk"
  });

  const zk = await proveSlot0Zk({
    slot0: mpt.storageFact.value,
    subject: mpt.fact.subject,
    block_number: mpt.fact.slot,
    state_root: mpt.fact.state_root,
    mpt_proof_hash: mpt.storageFact.proof_hash || mpt.verified.proofHash,
    out
  });

  const feedItem = createFeedItem({
    feed_id: "ethereum.uniswap_v3_slot0.zk",
    chain: "ethereum",
    predicate: "uniswap_v3_slot0",
    subject: mpt.fact.subject,
    value: {
      raw: mpt.storageFact.value,
      decoded: mpt.slot0,
      token1PerToken0: mpt.token1PerToken0
    },
    block_number: mpt.fact.slot,
    block_hash: mpt.verified.blockHash || null,
    state_root: mpt.fact.state_root,
    proof_system: "eip1186-mpt+groth16-bn128-uniswap-v3-slot0-dev",
    proof_hash: zk.proof_hash,
    proof_receipt: zk.receipt,
    witness_commitment: zk.job.witness_commitment,
    mpt_proof_hash: mpt.storageFact.proof_hash || mpt.verified.proofHash,
    paxiom_commitment: zk.receipt.commitment,
    corpus_commitment: mpt.fact.corpus_commitment,
    verification_level: "zk_verified",
    source: "paxiom-live-zk-slot0"
  });

  if (writeFeed) appendFeedItem(feedItem);

  return {
    pool: normalizeHex(pool),
    mpt,
    zk,
    feedItem,
    wroteFeed: writeFeed
  };
}

if (require.main === module) {
  proveLiveZkSlot0()
    .then(result => console.log(JSON.stringify({
      status: "ok",
      pool: result.pool,
      block_number: result.feedItem.block_number,
      state_root: result.feedItem.state_root,
      verification_level: result.feedItem.verification_level,
      proof_system: result.feedItem.proof_system,
      receipt_commitment: result.zk.receipt.commitment,
      feed_item_hash: result.feedItem.feed_item_hash,
      wrote_feed: result.wroteFeed
    }, null, 2)))
    .catch(err => {
      console.error(err.message);
      process.exit(1);
    });
}

module.exports = {
  proveLiveZkSlot0
};
