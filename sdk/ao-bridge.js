import { readFileSync, statSync } from 'fs';
import { spawn } from 'child_process';

const LOG_FILE = '/home/mk19/paxiom/opportunities.log';
const MONITOR_PROCESS = 'JbsXrqoy26CAE8_agv9ZX2aeL8-ec06yGETP7-6IvUg';
const MIN_SPREAD = 0.02;
const CHECK_INTERVAL = 10000;

// Gateway list — mix of locations and providers for resilience
const GATEWAYS = [
  'https://arweave.net',
  'https://arweave.developerdao.com',
  'https://ar.anyone.tech',
  'https://ariospeedwagon.com',
  'https://sulapan.com',
  'https://frostor.xyz',
  'https://arweave.fllstck.dev',
  'https://ar-node.megastake.org',
  'https://g8way.io',
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
  currentGatewayIndex = (currentGatewayIndex + 1) % GATEWAYS.length;
  console.log(`[${new Date().toISOString()}] Switched to: ${getCurrentGateway()}`);
}

// FIX: replace execSync shell interpolation with spawn + stdin pipe.
// Field values from the log file are passed through argv and stdin,
// never interpolated into a shell string.
function sendToAO(opportunity, attemptIndex = 0) {
  if (attemptIndex >= GATEWAYS.length) {
    console.log(`[${new Date().toISOString()}] All gateways failed — skipping`);
    return;
  }

  const gatewayIndex = (currentGatewayIndex + attemptIndex) % GATEWAYS.length;
  const gateway = GATEWAYS[gatewayIndex];
  const spreadBps = Math.round(parseFloat(opportunity.spreadPct) * 100);

  // Build the Lua send expression as a plain string — no shell involvement
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

  // spawn with argv array — shell never sees the Lua string.
  // Runtime prerequisite: `aos` CLI must be on $PATH (npm install -g aos@<pinned>).
  // systemd: ensure ExecStart unit's PATH includes the aos install location.
  const child = spawn('aos', [MONITOR_PROCESS, '--gateway', gateway], {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', d => stdout += d);
  child.stderr.on('data', d => stderr += d);

  child.on('close', code => {
    if (code === 0) {
      console.log(`[${new Date().toISOString()}] Sent via ${gateway}: ${opportunity.asset} ${opportunity.spreadPct}% ${opportunity.buyChain} -> ${opportunity.sellChain}`);
      currentGatewayIndex = gatewayIndex; // stick with working gateway
    } else {
      console.log(`[${new Date().toISOString()}] ${gateway} failed (exit ${code}) — trying next`);
      if (stderr) console.log(`[AO-BRIDGE] stderr: ${stderr.slice(0, 120)}`);
      markGatewayFailed(gateway);
      sendToAO(opportunity, attemptIndex + 1);
    }
  });

  child.on('error', err => {
    console.log(`[${new Date().toISOString()}] spawn error on ${gateway}: ${err.message}`);
    markGatewayFailed(gateway);
    sendToAO(opportunity, attemptIndex + 1);
  });

  // Write the Lua command to stdin and close it
  child.stdin.write(luaCmd + '\n');
  child.stdin.end();

  // Hard timeout — kill if aos hangs
  setTimeout(() => {
    if (!child.killed) {
      child.kill();
      console.log(`[${new Date().toISOString()}] Timeout — killed aos on ${gateway}`);
      markGatewayFailed(gateway);
      sendToAO(opportunity, attemptIndex + 1);
    }
  }, 10000);
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
      } catch(e) {
        console.log(`[AO-BRIDGE] Malformed log line: ${e.message}`);
      }
    }

    lastSize = size;
  } catch(e) {
    console.log(`[AO-BRIDGE] checkLog error: ${e.message}`);
  }
}

console.log('PaxiomAOBridge running');
console.log(`Monitor: ${MONITOR_PROCESS}`);
console.log(`Gateways: ${GATEWAYS.length} configured`);
console.log(`Min spread: ${MIN_SPREAD}%`);
console.log(`Watching: ${LOG_FILE}\n`);

setInterval(checkLog, CHECK_INTERVAL);
checkLog();
