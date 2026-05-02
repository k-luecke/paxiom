import { readFileSync, appendFileSync } from 'fs';
import { createServer } from 'http';
import { createWalletClient, createPublicClient, http, parseEther, encodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { optimismSepolia, baseSepolia } from 'viem/chains';

const LOG_FILE       = '/home/mk19/paxiom/opportunities.log';
const EXEC_LOG       = '/home/mk19/paxiom/execution.log';
const MIN_SPREAD     = 0.08;
const CHECK_INTERVAL = 15000;
const COOLDOWN_MS    = 60000;
const HTTP_PORT      = 7070;

const WETH        = '0x4200000000000000000000000000000000000006';
const WRAP_AMOUNT = parseEther('0.00001');
const WETH_ABI    = [{ name: 'deposit', type: 'function', stateMutability: 'payable', inputs: [], outputs: [] }];

const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) { console.error('ERROR: PRIVATE_KEY not set'); process.exit(1); }

const account    = privateKeyToAccount(`0x${PRIVATE_KEY.replace('0x','')}`);
const walletOp   = createWalletClient({ account, chain: optimismSepolia, transport: http('https://sepolia.optimism.io') });
const walletBase = createWalletClient({ account, chain: baseSepolia,     transport: http('https://sepolia.base.org') });
const publicOp   = createPublicClient({ chain: optimismSepolia,          transport: http('https://sepolia.optimism.io') });
const publicBase = createPublicClient({ chain: baseSepolia,               transport: http('https://sepolia.base.org') });

let lastSignalId = '';
let lastExecTime = 0;
let execCount    = 0;
let isExecuting  = false;

try {
  const _lines = readFileSync(LOG_FILE, 'utf8').trim().split('\n');
  lastSignalId = JSON.parse(_lines[_lines.length - 1]).timestamp;
  console.log(`Dedup initialized to: ${lastSignalId}`);
} catch(e) {}

function logExecution(entry) {
  appendFileSync(EXEC_LOG, JSON.stringify({ ...entry, timestamp: new Date().toISOString() }) + '\n');
  console.log(`\n${'='.repeat(62)}`);
  console.log(`[${entry.source ?? 'POLL'} #${execCount}] ${entry.asset} ${entry.spreadPct}%`);
  console.log(`Route:  ${entry.buyChain} -> ${entry.sellChain}`);
  console.log(`ChainA: ${entry.chainATxHash}`);
  console.log(`ChainB: ${entry.chainBTxHash}`);
  console.log(`Gap:    ${entry.timingGapMs}ms  Status: ${entry.status}`);
  console.log('='.repeat(62));
}

async function executeLive(opp, source = 'POLL') {
  if (isExecuting) return false;
  const now = Date.now();
  if (lastExecTime > 0 && now - lastExecTime < COOLDOWN_MS) {
    const remaining = Math.round((COOLDOWN_MS - (now - lastExecTime)) / 1000);
    console.log(`[COOLDOWN] ${remaining}s remaining`);
    return false;
  }
  isExecuting = true;
  execCount++;
  console.log(`\n[${source} #${execCount}] ${opp.asset} ${opp.spreadPct}% ${opp.buyChain} -> ${opp.sellChain}`);
  try {
    const [nonceOp, nonceBase] = await Promise.all([
      publicOp.getTransactionCount({ address: account.address }),
      publicBase.getTransactionCount({ address: account.address })
    ]);
    const calldata = encodeFunctionData({ abi: WETH_ABI, functionName: 'deposit' });
    const t0 = Date.now();
    const [chainAHash, chainBHash] = await Promise.all([
      walletOp.sendTransaction({ to: WETH, value: WRAP_AMOUNT, data: calldata, gas: 50000n, nonce: nonceOp }),
      walletBase.sendTransaction({ to: WETH, value: WRAP_AMOUNT, data: calldata, gas: 50000n, nonce: nonceBase })
    ]);
    const timingGapMs = Date.now() - t0;
    lastExecTime = Date.now();
    console.log(`OP:   https://sepolia-optimism.etherscan.io/tx/${chainAHash}`);
    console.log(`Base: https://sepolia.basescan.org/tx/${chainBHash}`);
    logExecution({ source, asset: opp.asset, spreadPct: opp.spreadPct,
      buyChain: opp.buyChain, sellChain: opp.sellChain,
      chainATxHash: chainAHash, chainBTxHash: chainBHash,
      timingGapMs, status: 'broadcast_success',
      estimatedProfit: 5000 * (parseFloat(opp.spreadPct) / 100) - 0.50 });
    Promise.all([
      publicOp.waitForTransactionReceipt({ hash: chainAHash, timeout: 30000 }),
      publicBase.waitForTransactionReceipt({ hash: chainBHash, timeout: 30000 })
    ]).then(([a, b]) => console.log(`Confirmed OP block ${a.blockNumber} | Base block ${b.blockNumber}`))
      .catch(() => console.log('Confirmation timeout'));
    return { chainAHash, chainBHash, timingGapMs };
  } catch(e) {
    console.error(`Error: ${e.message.slice(0, 120)}`);
    logExecution({ source, asset: opp.asset, spreadPct: opp.spreadPct,
      buyChain: opp.buyChain, sellChain: opp.sellChain,
      chainATxHash: `ERROR: ${e.message.slice(0, 80)}`,
      chainBTxHash: 'not reached', timingGapMs: 0, status: 'error', estimatedProfit: 0 });
    lastExecTime = Date.now();
    return false;
  } finally {
    isExecuting = false;
  }
}

const server = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/signal') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const opp = JSON.parse(body);
        console.log(`\n[AO SIGNAL] ${opp.asset} ${opp.spreadPct}%`);
        if (parseFloat(opp.spreadPct) < MIN_SPREAD) {
          res.writeHead(200); res.end(JSON.stringify({ status: 'skipped', reason: 'below threshold' })); return;
        }
        const result = await executeLive(opp, 'AO');
        res.writeHead(200); res.end(JSON.stringify({ status: result ? 'executed' : 'skipped', result }));
      } catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    });
  } else if (req.url === '/status') {
    res.writeHead(200);
    res.end(JSON.stringify({ execCount, isExecuting, wallet: account.address,
      cooldownRemaining: Math.max(0, COOLDOWN_MS - (Date.now() - lastExecTime)) }));
  } else { res.writeHead(404); res.end('not found'); }
});

server.listen(HTTP_PORT, '127.0.0.1', () => {
  console.log(`HTTP signal endpoint: http://127.0.0.1:${HTTP_PORT}/signal`);
});

async function poll() {
  if (isExecuting) return;
  try {
    const content = readFileSync(LOG_FILE, 'utf8');
    const lines   = content.trim().split('\n').filter(l => l.trim());
    const recent  = lines.slice(-3).map(l => JSON.parse(l));
    // Skip entire poll cycle if cooldown active
    const now = Date.now();
    if (lastExecTime > 0 && now - lastExecTime < COOLDOWN_MS) return;

    for (const opp of recent) {
      if (opp.timestamp === lastSignalId) continue;
      if (parseFloat(opp.spreadPct) < MIN_SPREAD) continue;
      if (!opp.capturable) continue;
      lastSignalId = opp.timestamp;
      await executeLive(opp, 'POLL');
      break;
    }
  } catch(e) {}
}

console.log('Paxiom Live Executor — Testnet Broadcast');
console.log(`Wallet: ${account.address}`);
console.log(`Min spread: ${MIN_SPREAD}%  Cooldown: ${COOLDOWN_MS/1000}s  Port: ${HTTP_PORT}\n`);

setInterval(poll, CHECK_INTERVAL);
poll();
