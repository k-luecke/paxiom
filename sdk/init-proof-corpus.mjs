import { createRequire } from "module";
import { readFileSync } from "fs";
import { createDataItemSigner, message, result } from "@permaweb/aoconnect";

const require = createRequire(import.meta.url);
const { createGenesisAnchor } = require("../core/proof-corpus");

const PROCESS_ID = process.env.PAXIOM_PROOF_CORPUS_PROCESS || "";
const AR_WALLET = process.env.AR_WALLET || "/home/mk19/.aos.json";

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find(value => value.startsWith(prefix));
  if (!found) return fallback;
  return found.slice(prefix.length);
}

if (!PROCESS_ID) {
  console.error("Set PAXIOM_PROOF_CORPUS_PROCESS to the AO proof-corpus process id");
  process.exit(1);
}

const genesis = createGenesisAnchor({
  genesis_root: arg("genesis-root") || undefined
});
const wallet = JSON.parse(readFileSync(AR_WALLET, "utf8"));
const signer = createDataItemSigner(wallet);

const msgId = await message({
  process: PROCESS_ID,
  tags: [{ name: "Action", value: "InitializeGenesis" }],
  data: JSON.stringify({
    chain: genesis.chain,
    state_root: genesis.state_root,
    commitment: genesis.commitment
  }),
  signer
});

const res = await result({ process: PROCESS_ID, message: msgId });
console.log(JSON.stringify({
  process: PROCESS_ID,
  message: msgId,
  genesis,
  response: res.Messages?.map(msg => ({
    action: msg.Tags?.find(tag => tag.name === "Action")?.value,
    data: msg.Data
  })) || []
}, null, 2));
