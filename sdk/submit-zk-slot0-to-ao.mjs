import { createRequire } from "module";
import { loadSigner, sendAoJson, latestMessageData } from "./ao-zk-client.mjs";

const require = createRequire(import.meta.url);
const { createAoDispatch } = require("../core/zk-pipeline");
const { proveLiveZkSlot0 } = require("./prove-live-zk-slot0.cjs");

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find(value => value.startsWith(prefix));
  if (!found) return fallback;
  return found.slice(prefix.length);
}

async function main() {
  const processId = arg("process", process.env.PAXIOM_ZK_COORDINATOR_PROCESS || "");
  const workerCount = Number(arg("workers", process.env.PAXIOM_ZK_WORKER_COUNT || "1"));
  const pool = arg("pool");

  if (!processId || !pool) {
    throw new Error("Usage: npm run zk:ao:slot0 -- --process=<ao-process> --pool=0x...");
  }

  const signer = await loadSigner();
  const live = await proveLiveZkSlot0({
    pool,
    blockTag: arg("block", "finalized"),
    token0Decimals: Number(arg("token0-decimals", "6")),
    token1Decimals: Number(arg("token1-decimals", "18")),
    writeFeed: arg("write-feed", process.env.PAXIOM_WRITE_FEED || "true") !== "false"
  });

  const dispatch = createAoDispatch(live.zk.job, workerCount);
  const jobRes = await sendAoJson({
    processId,
    action: "SubmitZkPredicateJob",
    data: dispatch.data,
    tags: dispatch.tags.slice(1),
    signer
  });
  const proofRes = await sendAoJson({
    processId,
    action: "SubmitZkPredicateProof",
    data: live.zk.receipt,
    tags: [
      { name: "Paxiom-Job-Id", value: live.zk.job.job_id },
      { name: "Paxiom-Predicate", value: live.zk.receipt.predicate }
    ],
    signer
  });

  console.log(JSON.stringify({
    status: "ok",
    job: latestMessageData(jobRes),
    proof: latestMessageData(proofRes),
    local: {
      block_number: live.feedItem.block_number,
      receipt_commitment: live.zk.receipt.commitment,
      feed_item_hash: live.feedItem.feed_item_hash
    }
  }, null, 2));
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
