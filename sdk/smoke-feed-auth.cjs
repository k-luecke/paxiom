const { spawn } = require("child_process");
const { existsSync, readFileSync } = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const runtimeDir = path.join(repoRoot, ".paxiom-runtime");
const tokenFile = path.join(runtimeDir, "pilot-token.json");
const subscribersFile = path.join(runtimeDir, "subscribers.json");
const feedFile = path.join(runtimeDir, "feed-items.jsonl");
const port = Number(process.env.PAXIOM_SMOKE_PORT || 7087);

function requireFile(file, hint) {
  if (!existsSync(file)) {
    throw new Error(`${file} does not exist. ${hint}`);
  }
}

async function request(pathname, token) {
  const headers = { accept: "application/json" };
  if (token) headers["x-paxiom-feed-token"] = token;
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { headers });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function waitForServer() {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    try {
      const res = await request("/health");
      if (res.status === 200) return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  throw new Error("feed server did not become ready");
}

async function main() {
  requireFile(tokenFile, "Run npm run feed:create-subscriber first.");
  requireFile(subscribersFile, "Run npm run feed:create-subscriber first.");
  requireFile(feedFile, "Run npm run proof:live -- --once with PAXIOM_FEED_FILE=.paxiom-runtime/feed-items.jsonl first.");

  const token = JSON.parse(readFileSync(tokenFile, "utf8")).token;
  if (!token) throw new Error("pilot token file does not contain token");

  const child = spawn(process.execPath, ["feed/server.mjs"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PAXIOM_FEED_PUBLIC_READ: "false",
      PAXIOM_FEED_PORT: String(port),
      PAXIOM_FEED_FILE: feedFile,
      PAXIOM_FEED_SUBSCRIBERS_FILE: subscribersFile
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let output = "";
  child.stdout.on("data", chunk => { output += chunk.toString(); });
  child.stderr.on("data", chunk => { output += chunk.toString(); });

  try {
    await waitForServer();

    const unauth = await request("/v1/feed/latest?limit=1");
    const auth = await request("/v1/feed/latest?limit=1", token);

    if (unauth.status !== 401) {
      throw new Error(`expected unauthenticated request to return 401, got ${unauth.status}`);
    }
    if (auth.status !== 200 || !auth.body?.items?.length) {
      throw new Error(`expected authenticated request to return feed items, got ${auth.status}`);
    }

    console.log(JSON.stringify({
      status: "ok",
      unauthenticated_status: unauth.status,
      subscriber: auth.body.subscriber,
      item_count: auth.body.items.length,
      predicate: auth.body.items[0].predicate,
      block_number: auth.body.items[0].block_number
    }, null, 2));
  } catch (err) {
    err.message += `\nServer output:\n${output}`;
    throw err;
  } finally {
    child.kill("SIGTERM");
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
