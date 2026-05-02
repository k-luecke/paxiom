import { readFileSync, statSync } from 'fs';
import { execSync } from 'child_process';

const LOG_FILE = '/home/mk19/paxiom/opportunities.log';
const MONITOR_PROCESS = 'JbsXrqoy26CAE8_agv9ZX2aeL8-ec06yGETP7-6IvUg';
const MIN_SPREAD = 0.02;
const CHECK_INTERVAL = 10000;

// Gateway list — mix of locations and providers for resilience
const GATEWAYS = [
  'https://arweave.net',               // primary — Seattle, Amazon
  'https://arweave.developerdao.com',  // Developer DAO — Portland, Amazon
  'https://ar.anyone.tech',            // ANyONe — Nuremberg, Hetzner
  'https://ariospeedwagon.com',        // Ario Speedwagon — Falkenstein, Hetzner
  'https://sulapan.com',               // CodeBlockLabs — Burlington
  'https://frostor.xyz',               // IDeployedTooSoon — Helsinki, Hetzner
  'https://arweave.fllstck.dev',       // Fllstck — Oberasbach
  'https://ar-node.megastake.org',     // Megastake — Nuremberg, Hetzner
  'https://g8way.io',                  // fallback
];

let lastSize = 0;
let lastProcessed = '';
let currentGatewayIndex = 0;
let gatewayFailCounts = {};

function getCurrentGateway() {
  return GATEWAYS[currentGatewayIndex];
}

function markGatewayFailed(gateway) {
  gatewayFailCounts[gateway] = (gatewayFailCounts[gateway] || 0) + 1;
  // Rotate to next gateway
  currentGatewayIndex = (currentGatewayIndex + 1) % GATEWAYS.length;
  console.log(`[${new Date().toISOString()}] Switched to: ${getCurrentGateway()}`);
}

function sendToAO(opportunity, attemptIndex = 0) {
  if (attemptIndex >= GATEWAYS.length) {
    console.log(`[${new Date().toISOString()}] All gateways failed — skipping`);
    return;
  }

  const gatewayIndex = (currentGatewayIndex + attemptIndex) % GATEWAYS.length;
  const gateway = GATEWAYS[gatewayIndex];
  const spreadBps = Math.round(parseFloat(opportunity.spreadPct) * 100);

  const luaCmd = [
    'Send({',
    `  Target = "${MONITOR_PROCESS}",`,
    `  Action = "EvaluateOpportunity",`,
    `  Spreadbps = "${spreadBps}",`,
    `  Asset = "${opportunity.asset}",`,
    `  Buychain = "${opportunity.buyChain}",`,
    `  Sellchain = "${opportunity.sellChain}",`,
    `  Buyprice = "${opportunity.buyPrice}",`,
    `  Sellprice = "${opportunity.sellPrice}",`,
    `  Capturable = "${opportunity.capturable}",`,
    `  Timestamp = tostring(os.time() * 1000)`,
    '})',
  ].join('\n');

  try {
    execSync(
      `echo '${luaCmd}' | aos ${MONITOR_PROCESS} --gateway ${gateway}`,
      { timeout: 8000, stdio: 'pipe' }
    );
    console.log(`[${new Date().toISOString()}] Sent via ${gateway}: ${opportunity.asset} ${opportunity.spreadPct}% ${opportunity.buyChain} -> ${opportunity.sellChain}`);
    currentGatewayIndex = gatewayIndex; // stick with working gateway
  } catch(e) {
    console.log(`[${new Date().toISOString()}] ${gateway} failed — trying next`);
    markGatewayFailed(gateway);
    sendToAO(opportunity, attemptIndex + 1);
  }
}

function checkLog() {
  try {
    const size = statSync(LOG_FILE).size;
    if (size <= lastSize) return;

    const content = readFileSync(LOG_FILE, 'utf8');
    const lines = content.trim().split('\n').filter(l => l.trim());
    const newLines = lines.slice(-5);

    for (const line of newLines) {
      try {
        const opp = JSON.parse(line);
        if (opp.timestamp === lastProcessed) continue;
        if (parseFloat(opp.spreadPct) < MIN_SPREAD) continue;
        if (!opp.capturable) continue;

        lastProcessed = opp.timestamp;
        console.log(`[${new Date().toISOString()}] Capturable: ${opp.asset} ${opp.spreadPct}% ${opp.buyChain} -> ${opp.sellChain}`);
        sendToAO(opp);
      } catch(e) {}
    }

    lastSize = size;
  } catch(e) {}
}

console.log('PaxiomAOBridge running');
console.log(`Monitor: ${MONITOR_PROCESS}`);
console.log(`Gateways: ${GATEWAYS.length} configured`);
console.log(`Min spread: ${MIN_SPREAD}%`);
console.log(`Watching: ${LOG_FILE}\n`);

setInterval(checkLog, CHECK_INTERVAL);
checkLog();
