import { createRequire } from "module";
import { createServer } from "http";
import { URL } from "url";

const require = createRequire(import.meta.url);
const { findByCommitment, latestBySubject, latestFeedItems } = require("./store");
const { getPredicate, listPredicates } = require("./predicates");
const {
  authenticateToken,
  filterItemsForSubscriber,
  itemAllowedForSubscriber,
  parseSubscribers
} = require("./auth");

const PORT = Number(process.env.PAXIOM_FEED_PORT || 7071);
const BIND = process.env.PAXIOM_FEED_BIND || "127.0.0.1";
const ALLOWED_ORIGIN = process.env.PAXIOM_FEED_ALLOWED_ORIGIN || "https://paxiom.org";
const PUBLIC_READ = process.env.PAXIOM_FEED_PUBLIC_READ === "true";
const RATE_LIMIT_PER_MIN = Number(process.env.PAXIOM_FEED_RATE_LIMIT_PER_MIN || 120);
const subscribers = parseSubscribers();
const rateBuckets = new Map();

function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "access-control-allow-origin": ALLOWED_ORIGIN,
    "access-control-allow-headers": "content-type,x-paxiom-feed-token",
    "access-control-allow-methods": "GET,OPTIONS"
  });
  res.end(JSON.stringify(body, null, 2));
}

function subscriberFromRequest(req) {
  const token = req.headers["x-paxiom-feed-token"];
  const subscriber = authenticateToken(token, subscribers);
  if (subscriber) return subscriber;
  if (PUBLIC_READ) return { id: "public", scopes: ["*"], status: "active" };
  return null;
}

function rateLimitKey(req, subscriber) {
  return subscriber?.id || req.socket.remoteAddress || "unknown";
}

function checkRateLimit(req, subscriber) {
  const key = rateLimitKey(req, subscriber);
  const now = Date.now();
  const windowStart = now - 60_000;
  const bucket = (rateBuckets.get(key) || []).filter(ts => ts > windowStart);
  if (bucket.length >= RATE_LIMIT_PER_MIN) {
    rateBuckets.set(key, bucket);
    return false;
  }
  bucket.push(now);
  rateBuckets.set(key, bucket);
  return true;
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": ALLOWED_ORIGIN,
      "access-control-allow-headers": "content-type,x-paxiom-feed-token",
      "access-control-allow-methods": "GET,OPTIONS",
      "access-control-max-age": "86400"
    });
    res.end();
    return;
  }

  if (url.pathname === "/health") {
    sendJson(res, 200, {
      status: "ok",
      service: "paxiom-feed",
      auth_required: !PUBLIC_READ,
      subscriber_count: subscribers.length,
      verification_levels: ["rpc_observed", "mpt_verified", "ao_committed", "recursive_verified", "zk_verified"]
    });
    return;
  }

  if (url.pathname === "/v1/predicates") {
    sendJson(res, 200, {
      items: listPredicates({
        includePlanned: url.searchParams.get("include_planned") !== "false"
      })
    });
    return;
  }

  if (url.pathname.startsWith("/v1/predicates/")) {
    const id = decodeURIComponent(url.pathname.split("/").pop() || "");
    const predicate = getPredicate(id);
    sendJson(res, predicate ? 200 : 404, predicate || { error: "not found" });
    return;
  }

  const subscriber = subscriberFromRequest(req);
  if (!subscriber) {
    sendJson(res, 401, {
      error: "Subscriber token required",
      hint: "Send x-paxiom-feed-token with an approved subscriber token"
    });
    return;
  }
  if (!checkRateLimit(req, subscriber)) {
    sendJson(res, 429, { error: "Rate limit exceeded" });
    return;
  }

  if (url.pathname === "/v1/feed/latest") {
    const items = filterItemsForSubscriber(
      latestFeedItems({
        limit: Number(url.searchParams.get("limit") || 50),
        predicate: url.searchParams.get("predicate") || undefined,
        subject: url.searchParams.get("subject") || undefined
      }),
      subscriber
    );
    sendJson(res, 200, {
      subscriber: subscriber.id,
      items
    });
    return;
  }

  if (url.pathname === "/v1/feed/subjects") {
    sendJson(res, 200, {
      subscriber: subscriber.id,
      items: filterItemsForSubscriber(latestBySubject(), subscriber)
    });
    return;
  }

  if (url.pathname.startsWith("/v1/feed/commitment/")) {
    const commitment = decodeURIComponent(url.pathname.split("/").pop() || "");
    const item = findByCommitment(commitment);
    if (!item) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    if (!itemAllowedForSubscriber(item, subscriber)) {
      sendJson(res, 403, { error: "Subscriber scope does not include this feed item" });
      return;
    }
    sendJson(res, 200, item);
    return;
  }

  sendJson(res, 404, { error: "not found" });
});

server.listen(PORT, BIND, () => {
  console.log(`Paxiom feed server running on http://${BIND}:${PORT}`);
  console.log(`Feed auth required: ${PUBLIC_READ ? "no" : "yes"}`);
  console.log(`Configured subscribers: ${subscribers.length}`);
});
