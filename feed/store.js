const crypto = require("crypto");
const { existsSync, mkdirSync, readFileSync, appendFileSync } = require("fs");
const { dirname, join } = require("path");
const { canonicalStringify, hashState } = require("../core/hash");

const DEFAULT_FEED_FILE = join(process.cwd(), "data", "feed-items.jsonl");

function ensureParent(file) {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function signPayload(payload, signingKey = process.env.PAXIOM_FEED_SIGNING_KEY || "") {
  if (!signingKey) return null;
  return crypto
    .createHmac("sha256", signingKey)
    .update(canonicalStringify(payload))
    .digest("hex");
}

function createFeedItem(input, options = {}) {
  const now = new Date().toISOString();
  const feedId = input.feed_id || `${input.chain || "ethereum"}.${input.predicate}`;
  const verificationLevel = input.verification_level || "mpt_verified";
  const custody = "none";

  const body = {
    schema: "paxiom.feed.v1",
    feed_id: feedId,
    chain: input.chain || "ethereum",
    predicate: input.predicate,
    subject: input.subject,
    value: input.value,
    block_number: input.block_number,
    block_hash: input.block_hash || null,
    state_root: input.state_root,
    proof_system: input.proof_system,
    proof_hash: input.proof_hash,
    proof_receipt: input.proof_receipt || null,
    witness_commitment: input.witness_commitment || null,
    mpt_proof_hash: input.mpt_proof_hash || null,
    paxiom_commitment: input.paxiom_commitment,
    corpus_commitment: input.corpus_commitment || null,
    verification_level: verificationLevel,
    custody,
    produced_at: input.produced_at || now,
    expires_at: input.expires_at || null,
    source: input.source || "paxiom-live-prover"
  };

  const item = {
    ...body,
    feed_item_hash: hashState(body)
  };
  return {
    ...item,
    signature: signPayload(item, options.signingKey)
  };
}

function appendFeedItem(item, file = process.env.PAXIOM_FEED_FILE || DEFAULT_FEED_FILE) {
  ensureParent(file);
  appendFileSync(file, `${JSON.stringify(item)}\n`);
  return item;
}

function readFeedItems(file = process.env.PAXIOM_FEED_FILE || DEFAULT_FEED_FILE) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function latestFeedItems({ limit = 50, predicate, subject, file } = {}) {
  let items = readFeedItems(file);
  if (predicate) items = items.filter(item => item.predicate === predicate);
  if (subject) items = items.filter(item => item.subject === subject);
  return items.slice(-limit).reverse();
}

function latestBySubject(file) {
  const out = new Map();
  for (const item of readFeedItems(file)) {
    const key = `${item.feed_id}:${item.subject}`;
    const previous = out.get(key);
    if (!previous || Number(item.block_number || 0) >= Number(previous.block_number || 0)) {
      out.set(key, item);
    }
  }
  return Array.from(out.values()).sort((a, b) => Number(b.block_number || 0) - Number(a.block_number || 0));
}

function findByCommitment(commitment, file) {
  return readFeedItems(file).find(item => item.paxiom_commitment === commitment || item.feed_item_hash === commitment) || null;
}

module.exports = {
  appendFeedItem,
  createFeedItem,
  findByCommitment,
  latestBySubject,
  latestFeedItems,
  readFeedItems
};
