const { mkdirSync, writeFileSync } = require("fs");
const { dirname, join, resolve } = require("path");
const { runSlot0Pipeline } = require("./zk-slot0-stages.cjs");

const repoRoot = resolve(__dirname, "..");

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find(value => value.startsWith(prefix));
  if (!found) return fallback;
  return found.slice(prefix.length);
}

function parsePools(value) {
  return String(value || "")
    .split(",")
    .map(item => item.trim())
    .filter(Boolean);
}

async function benchmarkZkSlot0(options = {}) {
  const pools = options.pools || parsePools(arg("pools", arg("pool", "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640")));
  const blockTag = options.blockTag || arg("block", "finalized");
  const repeats = Number(options.repeats || arg("repeats", "1"));
  const token0Decimals = Number(options.token0Decimals ?? arg("token0-decimals", "6"));
  const token1Decimals = Number(options.token1Decimals ?? arg("token1-decimals", "18"));
  const out = options.out || arg("out", join(repoRoot, ".paxiom-runtime", "zk-slot0-benchmark.json"));

  if (pools.length === 0) throw new Error("at least one pool is required");
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error("repeats must be a positive integer");

  const rows = [];
  for (const pool of pools) {
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      const run = await runSlot0Pipeline({
        pool,
        blockTag,
        token0Decimals,
        token1Decimals,
        writeFeed: false,
        corpusCommitment: "benchmark-unaggregated"
      });
      rows.push({
        pool: pool.toLowerCase(),
        subject: run.feedItem.subject,
        predicate: run.feedItem.predicate,
        block_number: run.feedItem.block_number,
        state_root: run.feedItem.state_root,
        repeat,
        feed_item_hash: run.feedItem.feed_item_hash,
        proof_hash: run.zk.proof_hash,
        receipt_commitment: run.zk.receipt.commitment,
        metadata_cache_hit: run.witness.metadata_cache_hit,
        stages: run.stages.map(stage => ({
          stage: stage.stage,
          elapsed_ms: stage.elapsed_ms
        })),
        total_elapsed_ms: Number(run.stages.reduce((sum, stage) => sum + stage.elapsed_ms, 0).toFixed(3))
      });
    }
  }

  const byStage = {};
  for (const row of rows) {
    for (const stage of row.stages) {
      byStage[stage.stage] = byStage[stage.stage] || [];
      byStage[stage.stage].push(stage.elapsed_ms);
    }
  }
  const stage_summary = Object.fromEntries(Object.entries(byStage).map(([stage, values]) => {
    const sum = values.reduce((a, b) => a + b, 0);
    return [stage, {
      count: values.length,
      min_ms: Number(Math.min(...values).toFixed(3)),
      max_ms: Number(Math.max(...values).toFixed(3)),
      avg_ms: Number((sum / values.length).toFixed(3))
    }];
  }));

  const report = {
    schema: "paxiom.zk_slot0_benchmark.v1",
    generated_at: new Date().toISOString(),
    block_tag: blockTag,
    repeats,
    predicate_count: 1,
    subject_count: pools.length,
    rows,
    stage_summary
  };

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  return { report, out };
}

if (require.main === module) {
  benchmarkZkSlot0()
    .then(({ report, out }) => console.log(JSON.stringify({
      status: "ok",
      out,
      rows: report.rows.length,
      block_tag: report.block_tag,
      stage_summary: report.stage_summary
    }, null, 2)))
    .catch(err => {
      console.error(err.stack || err.message);
      process.exit(1);
    });
}

module.exports = {
  benchmarkZkSlot0
};
