import { createDataItemSigner, message, result } from '@permaweb/aoconnect';
import { readFileSync } from 'fs';

const MONITOR_PROCESS = 'JbsXrqoy26CAE8_agv9ZX2aeL8-ec06yGETP7-6IvUg';
const PROOF_PROCESS   = process.env.PAXIOM_PROOF_PROCESS || MONITOR_PROCESS;
const EXECUTOR_URL    = 'http://127.0.0.1:7070/signal';
const POLL_INTERVAL   = 8000;
const AR_WALLET       = process.env.AR_WALLET || '/home/mk19/.aos.json';
const SIGNAL_TOKEN    = process.env.PAXIOM_SIGNAL_TOKEN || '';
const REQUIRE_GENESIS = process.env.PAXIOM_REQUIRE_GENESIS_PROOF !== 'false';

const wallet = JSON.parse(readFileSync(AR_WALLET, 'utf8'));
const signer = createDataItemSigner(wallet);

let lastSignalCount = 0;
let lastSignalId    = '';
let lastProofState  = null;

// Required fields for a valid opportunity signal
const REQUIRED_OPP_FIELDS = ['asset', 'spreadPct', 'buyChain', 'sellChain'];

function parseOpportunity(data) {
  // Expect the monitor process to embed the latest opportunity in status data.
  // Fields: asset, spreadPct, buyChain, sellChain, capturable, signalId
  const opp = data.latestOpportunity;
  if (!opp || typeof opp !== 'object') {
    console.log('[AO] No latestOpportunity in status payload — skipping');
    return null;
  }

  // Schema validation — reject if any required field is missing
  for (const field of REQUIRED_OPP_FIELDS) {
    if (opp[field] === undefined || opp[field] === null) {
      console.log(`[AO] Signal missing required field "${field}" — rejecting`);
      return null;
    }
  }

  // Dedup by signal id
  const signalId = opp.signalId || opp.timestamp || '';
  if (signalId && signalId === lastSignalId) {
    return null; // already processed
  }

  // Reject stale signals (older than 60 seconds if timestamp present)
  if (opp.timestamp) {
    const age = Date.now() - new Date(opp.timestamp).getTime();
    if (age > 60_000) {
      console.log(`[AO] Signal is ${Math.round(age/1000)}s old — rejecting as stale`);
      return null;
    }
  }

  return { ...opp, _signalId: signalId };
}

async function getProofState() {
  const msgId = await message({
    process: PROOF_PROCESS,
    tags: [{ name: 'Action', value: 'GetState' }],
    signer
  });

  const res = await result({ process: PROOF_PROCESS, message: msgId });
  if (!res.Messages?.length) {
    throw new Error('No proof state response');
  }

  const data = JSON.parse(res.Messages[res.Messages.length - 1].Data || '{}');
  lastProofState = data;
  return data;
}

async function pollAOMonitor() {
  try {
    const msgId = await message({
      process: MONITOR_PROCESS,
      tags: [{ name: 'Action', value: 'GetStatus' }],
      signer
    });

    const res = await result({ process: MONITOR_PROCESS, message: msgId });
    if (!res.Messages?.length) return;

    const data = JSON.parse(res.Messages[res.Messages.length - 1].Data || '{}');
    const signalCount = data.signalCount ?? 0;

    if (signalCount <= lastSignalCount) return;

    console.log(`[AO] New signal detected — count ${lastSignalCount} -> ${signalCount}`);
    lastSignalCount = signalCount;

    // Parse and validate the real opportunity from the AO payload
    const opp = parseOpportunity(data);
    if (!opp) return;

    if (REQUIRE_GENESIS) {
      const proofState = await getProofState();
      if (proofState.genesis_proven !== true) {
        console.log('[AO] Genesis proof incomplete — not forwarding execution signal');
        return;
      }
    }

    // Update dedup state
    lastSignalId = opp._signalId;

    console.log(`[AO] Forwarding opportunity: ${opp.asset} ${opp.spreadPct}% ${opp.buyChain} -> ${opp.sellChain}`);

    // Forward to executor (strip internal _signalId field)
    const { _signalId, ...oppClean } = opp;
    if (lastProofState) {
      oppClean.genesisProof = {
        genesis_proven: lastProofState.genesis_proven,
        genesis_slot: lastProofState.genesis_slot,
        genesis_state_root: lastProofState.genesis_state_root,
        latest_proven_slot: lastProofState.latest_proven_slot,
        latest_proven_state_root: lastProofState.latest_proven_state_root
      };
    }
    const resp = await fetch(EXECUTOR_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-paxiom-signal-token': SIGNAL_TOKEN
      },
      body: JSON.stringify(oppClean)
    });
    const execResult = await resp.json();
    console.log(`[AO] Executor: ${execResult.status}`);

  } catch(e) {
    console.log(`[AO] Poll error: ${e.message.slice(0, 80)}`);
  }
}

console.log('PaxiomAOPoller running');
console.log(`Monitor: ${MONITOR_PROCESS}`);
console.log(`Proof: ${PROOF_PROCESS}`);
console.log(`Executor: ${EXECUTOR_URL}`);
console.log(`Wallet: ${AR_WALLET}\n`);
console.log(`Require genesis proof: ${REQUIRE_GENESIS ? 'yes' : 'no'}`);
console.log(`Signal token configured: ${SIGNAL_TOKEN ? 'yes' : 'no'}\n`);

setInterval(pollAOMonitor, POLL_INTERVAL);
pollAOMonitor();
