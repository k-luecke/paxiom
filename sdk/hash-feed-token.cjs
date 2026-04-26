const { hashToken } = require("../feed/auth");

const token = process.argv[2] || process.env.PAXIOM_FEED_TOKEN || "";

if (!token) {
  console.error("Usage: node sdk/hash-feed-token.cjs <subscriber-token>");
  process.exit(1);
}

console.log(hashToken(token));
