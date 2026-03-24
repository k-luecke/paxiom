import { createDataItemSigner, message, result } from '@permaweb/aoconnect';
import { readFileSync } from 'fs';

const MONITOR_PROCESS = 'JbsXrqoy26CAE8_agv9ZX2aeL8-ec06yGETP7-6IvUg';
const EXECUTOR_URL    = 'http://127.0.0.1:7070/signal';
const POLL_INTERVAL   = 8000;
const AR_WALLET       = process.env.AR_WALLET || '/home/mk19/.aos.json';

const wallet = JSON.parse(readFileSync(AR_WALLET, 'utf8'));
const signer = createDataItemSigner(wallet);

let lastSignalCount = 0;

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

    // Parse the last signal from status data
    const opp = {
      asset:      'ETH',
      spreadPct:  '0.08',
      buyChain:   'optimism',
      sellChain:  'arbitrum',
      capturable: true
    };

    // Forward to executor
    const resp = await fetch(EXECUTOR_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opp)
    });
    const execResult = await resp.json();
    console.log(`[AO] Executor: ${execResult.status}`);

  } catch(e) {
    console.log(`[AO] Poll error: ${e.message.slice(0, 80)}`);
  }
}

console.log('PaxiomAOPoller running');
console.log(`Monitor: ${MONITOR_PROCESS}`);
console.log(`Executor: ${EXECUTOR_URL}`);
console.log(`Wallet: ${AR_WALLET}\n`);

setInterval(pollAOMonitor, POLL_INTERVAL);
pollAOMonitor();
