const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("fs");
const { dirname, join } = require("path");
const { hashCommitment } = require("./proof-corpus");

const DEFAULT_CACHE_FILE = join(process.cwd(), ".paxiom-runtime", "witness-cache.json");

function cacheKey(kind, input) {
  return hashCommitment(`WITNESS_CACHE:${kind}`, input);
}

function readWitnessCache(file = process.env.PAXIOM_WITNESS_CACHE_FILE || DEFAULT_CACHE_FILE) {
  if (!existsSync(file)) {
    return { version: 1, entries: {} };
  }
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (!parsed || parsed.version !== 1 || typeof parsed.entries !== "object") {
    throw new Error(`Invalid witness cache file: ${file}`);
  }
  return parsed;
}

function writeWitnessCache(cache, file = process.env.PAXIOM_WITNESS_CACHE_FILE || DEFAULT_CACHE_FILE) {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file, `${JSON.stringify(cache, null, 2)}\n`);
  return cache;
}

function putWitnessCacheEntry({ kind, input, value, file, producedAt = new Date().toISOString() }) {
  if (!kind || typeof kind !== "string") throw new Error("cache kind is required");
  if (!input || typeof input !== "object") throw new Error("cache input object is required");
  const cache = readWitnessCache(file);
  const key = cacheKey(kind, input);
  cache.entries[key] = {
    key,
    kind,
    input,
    value,
    produced_at: producedAt
  };
  writeWitnessCache(cache, file);
  return cache.entries[key];
}

function getWitnessCacheEntry({ kind, input, file }) {
  const cache = readWitnessCache(file);
  return cache.entries[cacheKey(kind, input)] || null;
}

function getOrPutWitnessCacheEntry({ kind, input, file, produce }) {
  const existing = getWitnessCacheEntry({ kind, input, file });
  if (existing) return { hit: true, entry: existing };
  if (typeof produce !== "function") throw new Error("produce function is required on cache miss");
  const entry = putWitnessCacheEntry({ kind, input, value: produce(), file });
  return { hit: false, entry };
}

function protocolMetadataCacheInput({ chain = "ethereum", protocol, subject }) {
  if (!protocol) throw new Error("protocol is required");
  if (!subject) throw new Error("subject is required");
  return {
    chain,
    protocol,
    subject: String(subject).toLowerCase()
  };
}

module.exports = {
  cacheKey,
  getOrPutWitnessCacheEntry,
  getWitnessCacheEntry,
  protocolMetadataCacheInput,
  putWitnessCacheEntry,
  readWitnessCache,
  writeWitnessCache
};
