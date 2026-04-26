const crypto = require("crypto");
const { existsSync, readFileSync } = require("fs");

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

function parseSubscribers(env = process.env) {
  const subscribers = [];

  if (env.PAXIOM_FEED_SUBSCRIBERS_FILE && existsSync(env.PAXIOM_FEED_SUBSCRIBERS_FILE)) {
    const fileSubscribers = JSON.parse(readFileSync(env.PAXIOM_FEED_SUBSCRIBERS_FILE, "utf8"));
    if (!Array.isArray(fileSubscribers)) throw new Error("PAXIOM_FEED_SUBSCRIBERS_FILE must contain a JSON array");
    subscribers.push(...fileSubscribers);
  }

  if (env.PAXIOM_FEED_SUBSCRIBERS) {
    const envSubscribers = JSON.parse(env.PAXIOM_FEED_SUBSCRIBERS);
    if (!Array.isArray(envSubscribers)) throw new Error("PAXIOM_FEED_SUBSCRIBERS must be a JSON array");
    subscribers.push(...envSubscribers);
  }

  if (env.PAXIOM_FEED_TOKEN) {
    subscribers.push({
      id: "legacy-token",
      token_hash: hashToken(env.PAXIOM_FEED_TOKEN),
      scopes: ["*"]
    });
  }

  return subscribers.map((subscriber, index) => ({
    id: String(subscriber.id || `subscriber-${index + 1}`),
    token_hash: subscriber.token_hash || hashToken(subscriber.token || ""),
    scopes: Array.isArray(subscriber.scopes) && subscriber.scopes.length ? subscriber.scopes : ["*"],
    status: subscriber.status || "active"
  }));
}

function authenticateToken(token, subscribers = parseSubscribers()) {
  if (!token) return null;
  const tokenHash = hashToken(token);
  return subscribers.find(subscriber =>
    subscriber.status === "active" &&
    timingSafeEqualHex(subscriber.token_hash, tokenHash)
  ) || null;
}

function itemAllowedForSubscriber(item, subscriber) {
  if (!subscriber) return false;
  if (subscriber.scopes.includes("*")) return true;
  const allowedScopes = new Set([
    item.feed_id,
    item.predicate,
    item.subject,
    `${item.feed_id}:${item.subject}`,
    `${item.predicate}:${item.subject}`,
    `feed:${item.feed_id}`,
    `predicate:${item.predicate}`,
    `subject:${item.subject}`,
    `feed:${item.feed_id}:subject:${item.subject}`,
    `predicate:${item.predicate}:subject:${item.subject}`
  ]);
  return subscriber.scopes.some(scope => allowedScopes.has(scope));
}

function filterItemsForSubscriber(items, subscriber) {
  return items.filter(item => itemAllowedForSubscriber(item, subscriber));
}

module.exports = {
  authenticateToken,
  filterItemsForSubscriber,
  hashToken,
  itemAllowedForSubscriber,
  parseSubscribers
};
