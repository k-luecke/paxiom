import { createDataItemSigner, message, result } from '@permaweb/aoconnect';
import { readFileSync } from 'fs';
import { createHmac, randomBytes } from 'crypto';
import { pathToFileURL } from 'url';

const MONITOR_PROCESS = 'JbsXrqoy26CAE8_agv9ZX2aeL8-ec06yGETP7-6IvUg';
const EXECUTOR_URL    = 'http://127.0.0.1:7070/signal';
const POLL_INTERVAL   = 8000;
const AR_WALLET       = process.env.AR_WALLET;
if (!AR_WALLET) {
  throw new Error('AR_WALLET env var is required (path to Arweave wallet JSON, e.g. ~/.aos.json)');
}
const SIGNAL_HMAC_HEX = process.env.PAXIOM_EXEC_SIGNAL_HMAC_KEY;
if (!SIGNAL_HMAC_HEX || Buffer.from(SIGNAL_HMAC_HEX, 'hex').length < 32) {
  throw new Error('PAXIOM_EXEC_SIGNAL_HMAC_KEY required (>=32 bytes hex); shared secret with sdk/live-executor.js');
}
const SIGNAL_HMAC_KEY = Buffer.from(SIGNAL_HMAC_HEX, 'hex');

// Audit follow-up #102: defer the wallet read so importing this module
// from a test or analyzer does not require AR_WALLET on disk. The signer
// is memoized; subsequent calls reuse the same instance.
let _signer = null;
function getSigner() {
  if (!_signer) {
    const wallet = JSON.parse(readFileSync(AR_WALLET, 'utf8'));
    _signer = createDataItemSigner(wallet);
  }
  return _signer;
}

let lastSignalCount = 0;
let lastSignalId    = '';

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

async function pollAOMonitor() {
  try {
    const msgId = await message({
      process: MONITOR_PROCESS,
      tags: [{ name: 'Action', value: 'GetStatus' }],
      signer: getSigner()
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

    // Update dedup state
    lastSignalId = opp._signalId;

    console.log(`[AO] Forwarding opportunity: ${opp.asset} ${opp.spreadPct}% ${opp.buyChain} -> ${opp.sellChain}`);

    // Forward to executor (strip internal _signalId field)
    const { _signalId, ...oppClean } = opp;
    const body  = JSON.stringify(oppClean);
    const ts    = Date.now().toString();
    const nonce = randomBytes(16).toString('hex');
    const hmac  = createHmac('sha256', SIGNAL_HMAC_KEY).update(`${ts}.${nonce}.${body}`).digest('hex');
    const resp = await fetch(EXECUTOR_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Paxiom-Signal-Ts': ts,
        'X-Paxiom-Signal-Nonce': nonce,
        'X-Paxiom-Signal-Hmac': hmac,
      },
      body,
    });
    const execResult = await resp.json();
    console.log(`[AO] Executor: ${execResult.status}`);

  } catch(e) {
    console.log(`[AO] Poll error: ${e.message.slice(0, 80)}`);
  }
}

function main() {
  console.log('PaxiomAOPoller running');
  console.log(`Monitor: ${MONITOR_PROCESS}`);
  console.log(`Executor: ${EXECUTOR_URL}`);
  console.log(`Wallet: ${AR_WALLET}\n`);
  setInterval(pollAOMonitor, POLL_INTERVAL);
  pollAOMonitor();
}

// Audit follow-up #102: only kick off the poll loop when this file is run
// as a script. Importing it from a test or tooling context returns the
// module exports without starting timers or logging.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export { pollAOMonitor, parseOpportunity, getSigner };
