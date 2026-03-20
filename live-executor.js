import { readFileSync, appendFileSync, statSync } from 'fs';
import { createWalletClient, createPublicClient, http, parseEther, encodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { optimismSepolia, baseSepolia } from 'viem/chains';

const LOG_FILE       = '/home/mk19/paxiom/opportunities.log';
const EXEC_LOG       = '/home/mk19/paxiom/execution.log';
const MIN_SPREAD     = 0.08;
const CHECK_INTERVAL = 15000;
const COOLDOWN_MS    = 60000; // 1 minute between executions

const WETH        = '0x4200000000000000000000000000000000000006';
const WRAP_AMOUNT = parseEther('0.0001');
const WETH_ABI    = [{ name: 'deposit', type: 'function', stateMutability: 'payable', inputs: [], outputs: [] }];

const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) { console.error('ERROR: PRIVATE_KEY not set'); process.exit(1); }

const account = privateKeyToAccount(`0x${PRIVATE_KEY.replace('0x','')}`);

const walletOp   = createWalletClient({ account, chain: optimismSepolia, transport: http('https://sepolia.optimism.io') });
const walletBase = createWalletClient({ account, chain: baseSepolia,     transport: http('https://sepolia.base.org') });
const publicOp   = createPublicClient({ chain: optimismSepolia,          transport: http('https://sepolia.optimism.io') });
const publicBase = createPublicClient({ chain: baseSepolia,               transport: http('https://sepolia.base.org') });

// ─── state ───────────────────────────────────────────────────
let lastSignalId  = '';
let lastExecTime  = 0;
let execCount     = 0;
let isExecuting   = false; // prevent concurrent executions

// Initialize dedup to current end of log
try {
  const _lines = readFileSync(LOG_FILE, 'utf8').trim().split('\n');
  lastSignalId = JSON.parse(_lines[_lines.length - 1]).timestamp;
  console.log(`Dedup initialized to: ${lastSignalId}`);
} catch(e) {}

// ─── logger ───────────────────────────────────────────────────
function logExecution(entry) {
  appendFileSync(EXEC_LOG, JSON.stringify({ ...entry, timestamp: new Date().toISOString() }) + '\n');
  console.log(`\n${'═'.repeat(62)}`);
  console.log(`[LIVE #${execCount}] ${entry.asset} ${entry.spreadPct}%`);
  console.log(`Route:      ${entry.buyChain} → ${entry.sellChain}`);
  console.log(`Chain A:    ${entry.chainATxHash}`);
  console.log(`Chain B:    ${entry.chainBTxHash}`);
  console.log(`Gap:        ${entry.timingGapMs}ms`);
  console.log(`Status:     ${entry.status}`);
  console.log('═'.repeat(62));
}

// ─── live execution ───────────────────────────────────────────
async function executeLive(opp) {
  if (isExecuting) {
    console.log(`[SKIP] Already executing — skipping ${opp.asset} ${opp.spreadPct}%`);
    return;
  }

  const now = Date.now();
  if (now - lastExecTime < COOLDOWN_MS) {
    const remaining = Math.round((COOLDOWN_MS - (now - lastExecTime)) / 1000);
    console.log(`[COOLDOWN] ${remaining}s remaining`);
    return;
  }

  isExecuting = true;
  execCount++;

  console.log(`\n[LIVE #${execCount}] ${opp.asset} ${opp.spreadPct}% ${opp.buyChain} → ${opp.sellChain}`);
  console.log(`Fetching nonces...`);

  try {
    // Fetch nonces fresh before every execution — prevents nonce collision
    const [nonceOp, nonceBase] = await Promise.all([
      publicOp.getTransactionCount({ address: account.address }),
      publicBase.getTransactionCount({ address: account.address })
    ]);
    console.log(`Nonces — Optimism: ${nonceOp}  Base: ${nonceBase}`);

    const calldata = encodeFunctionData({ abi: WETH_ABI, functionName: 'deposit' });

    const t0 = Date.now();

    // Broadcast both simultaneously with explicit nonces
    const [chainAHash, chainBHash] = await Promise.all([
      walletOp.sendTransaction({
        to: WETH, value: WRAP_AMOUNT, data: calldata,
        gas: 50000n, nonce: nonceOp
      }),
      walletBase.sendTransaction({
        to: WETH, value: WRAP_AMOUNT, data: calldata,
        gas: 50000n, nonce: nonceBase
      })
    ]);

    const timingGapMs = Date.now() - t0;
    lastExecTime = Date.now();

    console.log(`Both broadcast in ${timingGapMs}ms`);
    console.log(`Optimism: https://sepolia-optimism.etherscan.io/tx/${chainAHash}`);
    console.log(`Base:     https://sepolia.basescan.org/tx/${chainBHash}`);

    logExecution({
      asset: opp.asset, spreadPct: opp.spreadPct,
      buyChain: opp.buyChain, sellChain: opp.sellChain,
      chainATxHash: chainAHash, chainBTxHash: chainBHash,
      timingGapMs, status: 'broadcast_success',
      estimatedProfit: 5000 * (parseFloat(opp.spreadPct) / 100) - 0.50
    });

    // Confirm both
    console.log(`Waiting for confirmations...`);
    const [rcptA, rcptB] = await Promise.all([
      publicOp.waitForTransactionReceipt({ hash: chainAHash, timeout: 30000 }),
      publicBase.waitForTransactionReceipt({ hash: chainBHash, timeout: 30000 })
    ]);
    console.log(`Confirmed — Optimism block ${rcptA.blockNumber} | Base block ${rcptB.blockNumber}`);

  } catch(e) {
    console.error(`Execution error: ${e.message.slice(0, 120)}`);
    logExecution({
      asset: opp.asset, spreadPct: opp.spreadPct,
      buyChain: opp.buyChain, sellChain: opp.sellChain,
      chainATxHash: `ERROR: ${e.message.slice(0,80)}`,
      chainBTxHash: 'not reached',
      timingGapMs: 0, status: 'error',
      estimatedProfit: 0
    });
  } finally {
    isExecuting = false;
  }
}

// ─── poll ─────────────────────────────────────────────────────
async function poll() {
  if (isExecuting) return;
  try {
    const content = readFileSync(LOG_FILE, 'utf8');
    const lines   = content.trim().split('\n').filter(l => l.trim());
    const recent  = lines.slice(-3).map(l => JSON.parse(l));

    for (const opp of recent) {
      if (opp.timestamp === lastSignalId) continue;
      if (parseFloat(opp.spreadPct) < MIN_SPREAD) continue;
      if (!opp.capturable) continue;

      lastSignalId = opp.timestamp;
      await executeLive(opp);
      break; // one execution per poll cycle
    }
  } catch(e) {}
}

console.log('╔════════════════════════════════════════════════════════════╗');
console.log('║         PAXIOM LIVE EXECUTOR — TESTNET BROADCAST          ║');
console.log('╚════════════════════════════════════════════════════════════╝');
console.log(`Wallet:     ${account.address}`);
console.log(`Min spread: ${MIN_SPREAD}%`);
console.log(`Cooldown:   ${COOLDOWN_MS/1000}s between executions`);
console.log(`Chains:     Optimism Sepolia + Base Sepolia\n`);

setInterval(poll, CHECK_INTERVAL);
poll();
