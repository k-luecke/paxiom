import { readFileSync, appendFileSync } from 'fs';
import { createPublicClient, http, parseAbi } from 'viem';
import { optimismSepolia, baseSepolia, arbitrumSepolia } from 'viem/chains';

// ─── config ──────────────────────────────────────────────────
const SIMULATE = true; // flip to false for real broadcasts
const LOG_FILE = '/home/mk19/paxiom/simulation.log';
const MONITOR_PROCESS = 'JbsXrqoy26CAE8_agv9ZX2aeL8-ec06yGETP7-6IvUg';

// RPC endpoints
const RPCS = {
  optimism:  'https://mainnet.optimism.io',
  arbitrum:  'https://arb1.arbitrum.io/rpc',
  base:      'https://mainnet.base.org',
};

// Token addresses (mainnet for price simulation)
const TOKENS = {
  wstETH: {
    optimism: '0x1F32b1c2345538c0c6f582fCB022739c4A194Ebb',
    arbitrum: '0x5979D7b546E38E414F7E9822514be443A4800529',
  },
  ETH: {
    optimism: '0x4200000000000000000000000000000000000006',
    arbitrum: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    base:     '0x4200000000000000000000000000000000000006',
  },
  USDC: {
    optimism: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
    arbitrum: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    base:     '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  }
};

// Uniswap V3 routers
const ROUTERS = {
  optimism: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
  arbitrum: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
  base:     '0x2626664c2603336E57B271c5C0b26F421741e481',
};

// Capital per side
const CAPITAL_USDC = {
  wstETH: 5000,
  ETH:    5000,
};

// ─── simulation logger ────────────────────────────────────────
function logSimulation(entry) {
  const line = JSON.stringify({
    ...entry,
    timestamp: new Date().toISOString(),
    mode: 'SIMULATE'
  });
  appendFileSync(LOG_FILE, line + '\n');
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`[SIMULATE] ${entry.action}`);
  console.log(`Asset:      ${entry.asset}`);
  console.log(`Route:      ${entry.buyChain} → ${entry.sellChain}`);
  console.log(`Spread:     ${entry.spreadBps / 100}%`);
  console.log(`Capital:    $${entry.capitalUsdc} per side`);
  console.log(`Est profit: $${entry.estimatedProfit.toFixed(4)}`);
  console.log(`ChainA tx:  ${entry.chainATx}`);
  console.log(`ChainB tx:  ${entry.chainBTx}`);
  console.log(`Timing gap: ${entry.timingGapMs}ms`);
  console.log(`Time:       ${new Date().toISOString()}`);
  console.log('═'.repeat(60));
}

// ─── transaction builder ─────────────────────────────────────
function buildSwapTx(chain, tokenIn, tokenOut, amountIn, direction) {
  const router = ROUTERS[chain];
  const fee = 500; // 0.05% pool fee

  // ExactInputSingle params
  return {
    to: router,
    chain,
    direction,
    tokenIn,
    tokenOut,
    amountIn,
    fee,
    data: `exactInputSingle((${tokenIn},${tokenOut},${fee},recipient,${amountIn},0,0))`
  };
}

// ─── execution simulator ──────────────────────────────────────
async function simulateExecution(signal) {
  const {
    asset, spreadBps, buyChain, sellChain,
    buyPrice, sellPrice
  } = signal;

  const capital = CAPITAL_USDC[asset] || 5000;
  const spreadPct = spreadBps / 10000;
  const grossProfit = capital * spreadPct;
  const gasCost = 0.50;
  const netProfit = grossProfit - gasCost;

  // Build both transactions
  const chainAStart = Date.now();

  const chainATx = buildSwapTx(
    buyChain,
    TOKENS.USDC[buyChain],
    TOKENS[asset]?.[buyChain] || TOKENS.ETH[buyChain],
    capital * 1e6,
    'BUY'
  );

  const chainBTx = buildSwapTx(
    sellChain,
    TOKENS[asset]?.[sellChain] || TOKENS.ETH[sellChain],
    TOKENS.USDC[sellChain],
    capital * 1e6,
    'SELL'
  );

  const chainBStart = Date.now();
  const timingGapMs = chainBStart - chainAStart;

  // In simulate mode — log what would happen
  logSimulation({
    action:          'SIMULTANEOUS_EXECUTION',
    asset,
    spreadBps,
    buyChain,
    sellChain,
    buyPrice,
    sellPrice,
    capitalUsdc:     capital,
    grossProfit:     grossProfit,
    estimatedProfit: netProfit,
    chainATx:        `BUY ${asset} on ${buyChain} Uniswap — $${capital} USDC`,
    chainBTx:        `SELL ${asset} on ${sellChain} Uniswap — estimated $${(capital * (1 + spreadPct)).toFixed(2)} USDC`,
    timingGapMs,
    wouldBeProfitable: netProfit > 0
  });

  return { success: true, netProfit, timingGapMs };
}

// ─── AO signal listener ───────────────────────────────────────
// Polls for new execution signals from the AO monitor
// In production this would use aoconnect to watch the process inbox

let lastSignalId = 0;

async function pollForSignals() {
  try {
    // Read latest opportunities and check for new capturable ones
    const content = readFileSync('/home/mk19/paxiom/opportunities.log', 'utf8');
    const lines = content.trim().split('\n').filter(l => l.trim());
    const recent = lines.slice(-3).map(l => JSON.parse(l));

    for (const opp of recent) {
      const spread = parseFloat(opp.spreadPct);
      if (!opp.capturable) continue;
      if (spread < 0.02) continue;

      const signalId = opp.timestamp;
      if (signalId === lastSignalId) continue;
      lastSignalId = signalId;

      console.log(`\n[${new Date().toISOString()}] Signal received from scanner`);
      console.log(`Asset: ${opp.asset} | Spread: ${opp.spreadPct}% | ${opp.buyChain} -> ${opp.sellChain}`);

      await simulateExecution({
        asset:      opp.asset,
        spreadBps:  Math.round(parseFloat(opp.spreadPct) * 100),
        buyChain:   opp.buyChain,
        sellChain:  opp.sellChain,
        buyPrice:   opp.buyPrice,
        sellPrice:  opp.sellPrice,
      });
    }
  } catch(e) {
    // log file not ready yet
  }
}

// ─── main ─────────────────────────────────────────────────────
console.log('╔════════════════════════════════════════════════════════════╗');
console.log('║           PAXIOM SIGNING DAEMON — SIMULATE MODE           ║');
console.log('║     No real transactions will be broadcast                ║');
console.log('╚════════════════════════════════════════════════════════════╝');
console.log(`\nMonitor process: ${MONITOR_PROCESS}`);
console.log(`Simulation log:  ${LOG_FILE}`);
console.log(`Capital per side: $${CAPITAL_USDC.ETH} USDC`);
console.log('\nWatching for capturable opportunities...\n');

// Poll every 10 seconds aligned with scanner
setInterval(pollForSignals, 10000);
pollForSignals();
