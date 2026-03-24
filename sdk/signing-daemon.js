import { readFileSync, appendFileSync, statSync } from 'fs';
import { createWalletClient, createPublicClient, http, parseEther, encodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { optimismSepolia, baseSepolia } from 'viem/chains';

// ─── config ──────────────────────────────────────────────────
const SIMULATE = true;
const LOG_FILE      = '/home/mk19/paxiom/opportunities.log';
const SIM_LOG       = '/home/mk19/paxiom/simulation.log';
const EXEC_LOG      = '/home/mk19/paxiom/execution.log';
const MIN_SPREAD    = 0.02;
const CHECK_INTERVAL = 10000;

// WETH address — same on both OP chains
const WETH = '0x4200000000000000000000000000000000000006';

// Wrap amount — tiny, just proving the mechanism
const WRAP_AMOUNT = parseEther('0.0001'); // $0.20 worth

// WETH deposit ABI
const WETH_ABI = [{
  name: 'deposit',
  type: 'function',
  stateMutability: 'payable',
  inputs: [],
  outputs: []
}];

// ─── clients ─────────────────────────────────────────────────
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error('ERROR: PRIVATE_KEY not set');
  process.exit(1);
}

const account = privateKeyToAccount(`0x${PRIVATE_KEY.replace('0x','')}`);

const walletOp = createWalletClient({
  account,
  chain: optimismSepolia,
  transport: http('https://sepolia.optimism.io')
});

const walletBase = createWalletClient({
  account,
  chain: baseSepolia,
  transport: http('https://sepolia.base.org')
});

const publicOp = createPublicClient({
  chain: optimismSepolia,
  transport: http('https://sepolia.optimism.io')
});

const publicBase = createPublicClient({
  chain: baseSepolia,
  transport: http('https://sepolia.base.org')
});

console.log(`Wallet: ${account.address}`);

// ─── dedup ───────────────────────────────────────────────────
let lastSignalId = '';
try {
  const _lines = readFileSync(LOG_FILE, 'utf8').trim().split('\n');
  lastSignalId = JSON.parse(_lines[_lines.length - 1]).timestamp;
  console.log(`Resuming from: ${lastSignalId}`);
} catch(e) {}

// ─── execution logger ─────────────────────────────────────────
function logExecution(entry) {
  const line = JSON.stringify({ ...entry, timestamp: new Date().toISOString() });
  appendFileSync(EXEC_LOG, line + '\n');

  const profit = entry.estimatedProfit?.toFixed(4) ?? 'N/A';
  const gap    = entry.timingGapMs ?? 'N/A';

  console.log(`\n${'═'.repeat(62)}`);
  console.log(`[${entry.mode}] ${entry.asset} ${entry.spreadPct}%`);
  console.log(`Route:      ${entry.buyChain} → ${entry.sellChain}`);
  console.log(`Chain A tx: ${entry.chainATxHash ?? entry.chainATx}`);
  console.log(`Chain B tx: ${entry.chainBTxHash ?? entry.chainBTx}`);
  console.log(`Timing gap: ${gap}ms`);
  console.log(`Est profit: $${profit}`);
  console.log(`Time:       ${new Date().toISOString()}`);
  console.log('═'.repeat(62));
}

// ─── simultaneous broadcast ───────────────────────────────────
async function executeLive(opp) {
  const spreadPct = parseFloat(opp.spreadPct);
  const estimatedProfit = 5000 * (spreadPct / 100) - 0.50;

  console.log(`\n[LIVE] Signal: ${opp.asset} ${opp.spreadPct}% ${opp.buyChain} → ${opp.sellChain}`);
  console.log(`Broadcasting both chains simultaneously...`);

  // Build calldata for WETH deposit (wrap ETH) on both chains
  const calldata = encodeFunctionData({
    abi: WETH_ABI,
    functionName: 'deposit'
  });

  // Fire both transactions at the exact same moment
  // Promise.all ensures both are submitted before either awaits
  const t0 = Date.now();

  let chainAHash, chainBHash, chainAError, chainBError;

  try {
    [chainAHash, chainBHash] = await Promise.all([
      walletOp.sendTransaction({
        to: WETH,
        value: WRAP_AMOUNT,
        data: calldata,
        gas: 50000n
      }),
      walletBase.sendTransaction({
        to: WETH,
        value: WRAP_AMOUNT,
        data: calldata,
        gas: 50000n
      })
    ]);
  } catch(e) {
    console.error(`Broadcast error: ${e.message}`);
    chainAError = e.message;
  }

  const timingGapMs = Date.now() - t0;

  logExecution({
    mode:            'LIVE',
    asset:           opp.asset,
    spreadPct:       opp.spreadPct,
    buyChain:        opp.buyChain,
    sellChain:       opp.sellChain,
    chainATxHash:    chainAHash ?? `ERROR: ${chainAError}`,
    chainBTxHash:    chainBHash ?? 'not reached',
    timingGapMs,
    estimatedProfit,
    wrapAmount:      '0.0001 ETH per chain'
  });

  // Wait for confirmations and report
  if (chainAHash && chainBHash) {
    console.log(`\nWaiting for confirmations...`);
    try {
      const [receiptA, receiptB] = await Promise.all([
        publicOp.waitForTransactionReceipt({ hash: chainAHash, timeout: 30000 }),
        publicBase.waitForTransactionReceipt({ hash: chainBHash, timeout: 30000 })
      ]);
      console.log(`Chain A confirmed: block ${receiptA.blockNumber}`);
      console.log(`Chain B confirmed: block ${receiptB.blockNumber}`);
      console.log(`\nOptimism: https://sepolia-optimism.etherscan.io/tx/${chainAHash}`);
      console.log(`Base:     https://sepolia.basescan.org/tx/${chainBHash}`);
    } catch(e) {
      console.log(`Confirmation timeout — txs broadcast, check explorers`);
    }
  }
}

// ─── poll loop ────────────────────────────────────────────────
async function poll() {
  try {
    const size = statSync(LOG_FILE).size;
    const content = readFileSync(LOG_FILE, 'utf8');
    const lines = content.trim().split('\n').filter(l => l.trim());
    const recent = lines.slice(-5).map(l => JSON.parse(l));

    for (const opp of recent) {
      if (opp.timestamp === lastSignalId) continue;
      if (parseFloat(opp.spreadPct) < MIN_SPREAD) continue;
      if (!opp.capturable) continue;

      lastSignalId = opp.timestamp;
      await executeLive(opp);
    }
  } catch(e) {
    // log not ready
  }
}

// ─── main ─────────────────────────────────────────────────────
console.log('╔════════════════════════════════════════════════════════════╗');
console.log('║          PAXIOM SIGNING DAEMON — LIVE TESTNET MODE        ║');
console.log('║     Broadcasting real transactions to Sepolia              ║');
console.log('╚════════════════════════════════════════════════════════════╝');
console.log(`\nChains:   Optimism Sepolia + Base Sepolia`);
console.log(`Wrap:     0.0001 ETH per chain per execution`);
console.log(`Min spread: ${MIN_SPREAD}%\n`);

setInterval(poll, CHECK_INTERVAL);
poll();
