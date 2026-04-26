const { normalizeHex } = require("../core/eth-proof");
const { runSlot0Pipeline } = require("./zk-slot0-stages.cjs");

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

  const result = await runSlot0Pipeline({
    pool,
    blockTag,
    token0Decimals,
    token1Decimals,
    corpusCommitment: options.corpusCommitment || "local-live-zk",
    writeFeed,
    out
  });

  return {
    pool: normalizeHex(pool),
    mpt: result.witness.mpt,
    zk: result.zk,
    feedItem: result.feedItem,
    wroteFeed: writeFeed,
    stages: result.stages
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
