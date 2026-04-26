const { appendFeedItem, createFeedItem } = require("../feed/store");
const { normalizeHex } = require("../core/eth-proof");
const { hashState } = require("../core/hash");
const { createSlot0ZkInput } = require("../core/slot0-zk-input");
const { decodeSlot0, estimatePriceFromTick } = require("../core/uniswap-v3");
const {
  getOrPutWitnessCacheEntry,
  protocolMetadataCacheInput
} = require("../core/witness-cache");
const { proveUniswapV3Slot0 } = require("./prove-uniswap-v3-slot0.cjs");
const { proveSlot0Zk } = require("./prove-zk-slot0.cjs");

function nowIso() {
  return new Date().toISOString();
}

function timedStage(stage, fn) {
  const startedAt = nowIso();
  const started = process.hrtime.bigint();
  return Promise.resolve()
    .then(fn)
    .then(value => {
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      return {
        stage,
        started_at: startedAt,
        finished_at: nowIso(),
        elapsed_ms: Number(elapsedMs.toFixed(3)),
        value
      };
    });
}

function cacheSlot0Metadata({ pool, token0Decimals, token1Decimals, slot = "0x0" }) {
  const input = protocolMetadataCacheInput({
    protocol: "uniswap_v3_slot0",
    subject: normalizeHex(pool)
  });
  return getOrPutWitnessCacheEntry({
    kind: "protocol_metadata",
    input,
    produce: () => ({
      pool: normalizeHex(pool),
      slot,
      token0_decimals: token0Decimals,
      token1_decimals: token1Decimals,
      abi_selectors: {},
      event_topics: {},
      note: "Stable metadata cache; block-specific slot value remains uncached."
    })
  });
}

async function generateSlot0Witness(options = {}) {
  const pool = options.pool;
  if (!pool) throw new Error("pool is required");
  const token0Decimals = Number(options.token0Decimals ?? 6);
  const token1Decimals = Number(options.token1Decimals ?? 18);
  const metadata = cacheSlot0Metadata({ pool, token0Decimals, token1Decimals });

  const mpt = await proveUniswapV3Slot0({
    pool,
    blockTag: options.blockTag || "finalized",
    token0Decimals,
    token1Decimals,
    corpusCommitment: options.corpusCommitment || "local-live-zk"
  });

  const slot0Input = createSlot0ZkInput(mpt.storageFact.value);
  const decoded = decodeSlot0(mpt.storageFact.value);
  const witnessCommitment = hashState({
    slot0: mpt.storageFact.value,
    decoded,
    mpt_proof_hash: mpt.storageFact.proof_hash || mpt.verified.proofHash,
    state_root: mpt.fact.state_root,
    block_number: mpt.fact.slot
  });

  return {
    schema: "paxiom.zk_witness.v1",
    chain: "ethereum",
    predicate: "uniswap_v3_slot0",
    subject: mpt.fact.subject,
    block_number: mpt.fact.slot,
    state_root: mpt.fact.state_root,
    block_hash: mpt.verified.blockHash || null,
    raw_value: mpt.storageFact.value,
    decoded,
    token1PerToken0: estimatePriceFromTick(decoded.tick, token0Decimals, token1Decimals),
    slot0_input: slot0Input,
    mpt_proof_hash: mpt.storageFact.proof_hash || mpt.verified.proofHash,
    witness_commitment: witnessCommitment,
    metadata_cache_key: metadata.entry.key,
    metadata_cache_hit: metadata.hit,
    mpt
  };
}

async function proveSlot0Witness(witness, options = {}) {
  if (!witness || witness.schema !== "paxiom.zk_witness.v1") {
    throw new Error("valid slot0 witness is required");
  }
  return proveSlot0Zk({
    slot0: witness.raw_value,
    subject: witness.subject,
    block_number: witness.block_number,
    state_root: witness.state_root,
    mpt_proof_hash: witness.mpt_proof_hash,
    out: options.out
  });
}

function verifySlot0Proof({ witness, zk }) {
  if (!witness || !zk || !zk.receipt) throw new Error("witness and zk result are required");
  if (zk.receipt.job_id !== zk.job.job_id) throw new Error("receipt job id mismatch");
  if (zk.job.witness_commitment !== witness.witness_commitment) {
    throw new Error("witness commitment mismatch");
  }
  if (zk.receipt.block_number !== witness.block_number) throw new Error("block mismatch");
  if (zk.receipt.state_root !== witness.state_root) throw new Error("state root mismatch");
  return {
    verified: true,
    receipt_commitment: zk.receipt.commitment,
    proof_hash: zk.proof_hash
  };
}

function emitSlot0Receipt({ witness, zk, writeFeed = true }) {
  const feedItem = createFeedItem({
    feed_id: "ethereum.uniswap_v3_slot0.zk",
    chain: "ethereum",
    predicate: "uniswap_v3_slot0",
    subject: witness.subject,
    value: {
      raw: witness.raw_value,
      decoded: witness.decoded,
      token1PerToken0: witness.token1PerToken0
    },
    block_number: witness.block_number,
    block_hash: witness.block_hash,
    state_root: witness.state_root,
    proof_system: "eip1186-mpt+groth16-bn128-uniswap-v3-slot0-dev",
    proof_hash: zk.proof_hash,
    proof_receipt: zk.receipt,
    witness_commitment: zk.job.witness_commitment,
    mpt_proof_hash: witness.mpt_proof_hash,
    paxiom_commitment: zk.receipt.commitment,
    corpus_commitment: witness.mpt.fact.corpus_commitment,
    verification_level: "zk_verified",
    source: "paxiom-zk-slot0-staged"
  });
  if (writeFeed) appendFeedItem(feedItem);
  return feedItem;
}

async function runSlot0Pipeline(options = {}) {
  const stages = [];
  const witnessStage = await timedStage("witness", () => generateSlot0Witness(options));
  stages.push({ ...witnessStage, value: { witness_commitment: witnessStage.value.witness_commitment } });

  const proofStage = await timedStage("prove", () => proveSlot0Witness(witnessStage.value, options));
  stages.push({ ...proofStage, value: { job_id: proofStage.value.job.job_id, proof_hash: proofStage.value.proof_hash } });

  const verifyStage = await timedStage("verify", () => verifySlot0Proof({
    witness: witnessStage.value,
    zk: proofStage.value
  }));
  stages.push(verifyStage);

  const receiptStage = await timedStage("receipt", () => emitSlot0Receipt({
    witness: witnessStage.value,
    zk: proofStage.value,
    writeFeed: options.writeFeed !== false
  }));
  stages.push({ ...receiptStage, value: { feed_item_hash: receiptStage.value.feed_item_hash } });

  return {
    witness: witnessStage.value,
    zk: proofStage.value,
    verification: verifyStage.value,
    feedItem: receiptStage.value,
    stages
  };
}

module.exports = {
  cacheSlot0Metadata,
  emitSlot0Receipt,
  generateSlot0Witness,
  proveSlot0Witness,
  runSlot0Pipeline,
  timedStage,
  verifySlot0Proof
};
