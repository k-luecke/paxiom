import { createRequire } from "module";
import { createServer } from "http";
import { URL } from "url";

const require = createRequire(import.meta.url);
const { findByCommitment, latestBySubject, latestFeedItems } = require("./store");

const PORT = Number(process.env.PAXIOM_FEED_PORT || 7071);
const BIND = process.env.PAXIOM_FEED_BIND || "127.0.0.1";
const API_TOKEN = process.env.PAXIOM_FEED_TOKEN || "";
const ALLOWED_ORIGIN = process.env.PAXIOM_FEED_ALLOWED_ORIGIN || "https://paxiom.org";

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

function requireToken(req) {
  if (!API_TOKEN) return true;
  return req.headers["x-paxiom-feed-token"] === API_TOKEN;
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

  if (!requireToken(req)) {
    sendJson(res, 401, { error: "Invalid feed token" });
    return;
  }

  if (url.pathname === "/health") {
    sendJson(res, 200, {
      status: "ok",
      service: "paxiom-feed",
      verification_levels: ["rpc_observed", "mpt_verified", "ao_committed", "recursive_verified", "zk_verified"]
    });
    return;
  }

  if (url.pathname === "/v1/feed/latest") {
    sendJson(res, 200, {
      items: latestFeedItems({
        limit: Number(url.searchParams.get("limit") || 50),
        predicate: url.searchParams.get("predicate") || undefined,
        subject: url.searchParams.get("subject") || undefined
      })
    });
    return;
  }

  if (url.pathname === "/v1/feed/subjects") {
    sendJson(res, 200, { items: latestBySubject() });
    return;
  }

  if (url.pathname.startsWith("/v1/feed/commitment/")) {
    const commitment = decodeURIComponent(url.pathname.split("/").pop() || "");
    const item = findByCommitment(commitment);
    sendJson(res, item ? 200 : 404, item || { error: "not found" });
    return;
  }

  sendJson(res, 404, { error: "not found" });
});

server.listen(PORT, BIND, () => {
  console.log(`Paxiom feed server running on http://${BIND}:${PORT}`);
  console.log(`Feed token required: ${API_TOKEN ? "yes" : "no"}`);
});
