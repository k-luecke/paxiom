const crypto = require("crypto");
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("fs");
const { dirname } = require("path");
const { hashToken } = require("../feed/auth");

function parseArgs(argv) {
  const args = {
    id: "",
    file: "",
    scopes: []
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--id") args.id = argv[++i] || "";
    else if (arg.startsWith("--id=")) args.id = arg.slice("--id=".length);
    else if (arg === "--file") args.file = argv[++i] || "";
    else if (arg.startsWith("--file=")) args.file = arg.slice("--file=".length);
    else if (arg === "--scope") args.scopes.push(argv[++i] || "");
    else if (arg.startsWith("--scope=")) args.scopes.push(arg.slice("--scope=".length));
    else if (arg === "--help" || arg === "-h") args.help = true;
  }

  return args;
}

function usage() {
  console.log(`Usage:
  npm run feed:create-subscriber -- --id <subscriber-id> --file <subscribers.json> --scope <scope>

Example:
  npm run feed:create-subscriber -- \\
    --id pilot-uniswap-slot0 \\
    --file .paxiom-runtime/subscribers.json \\
    --scope predicate:uniswap_v3_slot0 \\
    --scope subject:ethereum:0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640:slot0`);
}

function readSubscribers(file) {
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(parsed)) throw new Error("Subscriber file must contain a JSON array");
  return parsed;
}

function writeSubscribers(file, subscribers) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(subscribers, null, 2)}\n`);
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.id || !args.file || !args.scopes.length) {
  usage();
  process.exit(args.help ? 0 : 1);
}

const token = `paxiom_${crypto.randomBytes(32).toString("hex")}`;
const subscribers = readSubscribers(args.file).filter(subscriber => subscriber.id !== args.id);
const subscriber = {
  id: args.id,
  status: "active",
  token_hash: hashToken(token),
  scopes: args.scopes.filter(Boolean)
};

subscribers.push(subscriber);
writeSubscribers(args.file, subscribers);

console.log(JSON.stringify({
  id: subscriber.id,
  token,
  token_hash: subscriber.token_hash,
  scopes: subscriber.scopes,
  file: args.file
}, null, 2));
