import { createRequire } from "module";
import { readFileSync } from "fs";
import { createDataItemSigner, message, result } from "@permaweb/aoconnect";

const require = createRequire(import.meta.url);
const { createSegmentProof, hashCommitment } = require("../core/proof-corpus");
const { normalizeHex } = require("../core/eth-proof");
const { proveStorage } = require("./prove-eth-storage.cjs");

const DEFAULT_RPC_URL = "https://ethereum-rpc.publicnode.com";
const RPC_URL = process.env.ETH_RPC_URL || DEFAULT_RPC_URL;
const PROCESS_ID = process.env.PAXIOM_PROOF_CORPUS_PROCESS || "";
const AR_WALLET = process.env.AR_WALLET || "/home/mk19/.aos.json";
const POLL_MS = Number(process.env.PAXIOM_LIVE_POLL_MS || 12_000);
const BLOCK_TAG = process.env.PAXIOM_LIVE_BLOCK_TAG || "finalized";
const WATCH_ADDRESS = process.env.PAXIOM_WATCH_ADDRESS || "";
const WATCH_SLOT = process.env.PAXIOM_WATCH_SLOT || "0x0";
const RUN_ONCE = process.argv.includes("--once");

let signer = null;
let latestSubmitted = null;

async function rpc(method, params) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: controller.signal
  }).finally(() => clearTimeout(timeout));
  const json = await res.json();
  if (json.error) {
    throw new Error(`${method} failed: ${json.error.message}`);
  }
  return json.result;
}

function quantityToNumber(value) {
  return Number(BigInt(value));
}

async function loadSigner() {
  if (!PROCESS_ID) return null;
  if (signer) return signer;
  const wallet = JSON.parse(readFileSync(AR_WALLET, "utf8"));
  signer = createDataItemSigner(wallet);
  return signer;
}

async function sendAO(action, data) {
  if (!PROCESS_ID) return null;
  const activeSigner = await loadSigner();
  const msgId = await message({
    process: PROCESS_ID,
    tags: [{ name: "Action", value: action }],
    data: JSON.stringify(data),
    signer: activeSigner
  });
  return result({ process: PROCESS_ID, message: msgId });
}

async function getCorpusState() {
  const res = await sendAO("GetCorpusState", {});
  if (!res?.Messages?.length) return null;
  return JSON.parse(res.Messages[res.Messages.length - 1].Data || "{}");
}

function createHeaderSegment(previous, current) {
  if (current.parentHash.toLowerCase() !== previous.hash.toLowerCase()) {
    throw new Error(`Header continuity failed: ${current.number} parent does not match previous hash`);
  }

  const proofHash = hashCommitment("ETH_HEADER_CONTINUITY", {
    parentHash: normalizeHex(current.parentHash),
    blockHash: normalizeHex(current.hash),
    blockNumber: current.number,
    stateRoot: normalizeHex(current.stateRoot),
    receiptsRoot: normalizeHex(current.receiptsRoot),
    transactionsRoot: normalizeHex(current.transactionsRoot)
  });

  return createSegmentProof({
    from_slot: quantityToNumber(previous.number),
    to_slot: quantityToNumber(current.number),
    from_state_root: normalizeHex(previous.stateRoot),
    to_state_root: normalizeHex(current.stateRoot),
    proof_system: "ethereum-header-continuity",
    proof_hash: proofHash,
    public_inputs: {
      parent_hash: normalizeHex(current.parentHash),
      block_hash: normalizeHex(current.hash),
      block_number: quantityToNumber(current.number),
      block_tag: BLOCK_TAG
    }
  });
}

async function submitSegment(segment) {
  const data = {
    from_slot: segment.from_slot,
    to_slot: segment.to_slot,
    from_state_root: segment.from_state_root,
    to_state_root: segment.to_state_root,
    proof_system: segment.proof_system,
    proof_hash: segment.proof_hash,
    commitment: segment.commitment
  };
  await sendAO("SubmitSegmentProof", data);
}

async function submitStorageFact(block, corpusCommitment) {
  if (!WATCH_ADDRESS) return null;
  const { fact } = await proveStorage({
    rpcUrl: RPC_URL,
    address: WATCH_ADDRESS,
    slot: WATCH_SLOT,
    blockTag: block.number,
    corpusCommitment
  });

  await sendAO("SubmitFactProof", {
    slot: fact.slot,
    state_root: fact.state_root,
    predicate: fact.predicate,
    subject: fact.subject,
    value: fact.value,
    corpus_commitment: fact.corpus_commitment,
    proof_hash: fact.proof_hash,
    commitment: fact.commitment
  });
  return fact;
}

async function tick() {
  const current = await rpc("eth_getBlockByNumber", [BLOCK_TAG, false]);
  if (!current) throw new Error(`No block returned for tag ${BLOCK_TAG}`);
  const currentNumber = quantityToNumber(current.number);
  if (latestSubmitted !== null && currentNumber <= latestSubmitted) return;

  const previousNumberHex = `0x${(BigInt(current.number) - 1n).toString(16)}`;
  const previous = await rpc("eth_getBlockByNumber", [previousNumberHex, false]);
  if (!previous) throw new Error(`No previous block returned for ${previousNumberHex}`);

  const segment = createHeaderSegment(previous, current);
  latestSubmitted = currentNumber;

  let aoState = null;
  if (PROCESS_ID) {
    aoState = await getCorpusState();
    if (aoState?.latest?.slot === segment.from_slot && aoState?.latest?.state_root === segment.from_state_root) {
      await submitSegment(segment);
    } else {
      console.log("[live-eth] AO corpus not aligned; segment held locally");
    }
  }

  let fact = null;
  if (WATCH_ADDRESS) {
    const corpusCommitment = aoState?.latest?.commitment || segment.commitment;
    fact = await submitStorageFact(current, corpusCommitment);
  }

  console.log(JSON.stringify({
    status: "proved",
    block: currentNumber,
    stateRoot: segment.to_state_root,
    segmentCommitment: segment.commitment,
    aoProcess: PROCESS_ID || null,
    storageFactCommitment: fact?.commitment || null
  }));
}

console.log("Paxiom live Ethereum prover running");
console.log(`RPC: ${RPC_URL}`);
console.log(`Block tag: ${BLOCK_TAG}`);
console.log(`AO corpus process: ${PROCESS_ID || "disabled"}`);
console.log(`Storage watch: ${WATCH_ADDRESS ? `${WATCH_ADDRESS}:${WATCH_SLOT}` : "disabled"}`);
console.log("");

if (RUN_ONCE) {
  await tick();
  process.exit(0);
} else {
  await tick().catch(err => console.log(`[live-eth] ${err.message}`));
  setInterval(() => tick().catch(err => console.log(`[live-eth] ${err.message}`)), POLL_MS);
}
