import { readFileSync, appendFileSync } from 'fs';
import { createServer } from 'http';
import { createHmac, timingSafeEqual } from 'crypto';
import { createWalletClient, createPublicClient, http, parseEther, encodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { optimismSepolia, baseSepolia, arbitrumSepolia } from 'viem/chains';

const LOG_FILE       = '/home/mk19/paxiom/opportunities.log';
const EXEC_LOG       = '/home/mk19/paxiom/execution.log';
const MIN_SPREAD     = 0.08;
const CHECK_INTERVAL = 15000;
const COOLDOWN_MS    = 60000;
const HTTP_PORT      = 7070;

// ─── chain config ────────────────────────────────────────────
// Set MAINNET = true when wallet is funded and ready for live trading
const MAINNET = false;

const CHAIN_CONFIG = MAINNET ? {
  // Mainnet addresses
  optimism: {
    usdc:   '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
    weth:   '0x4200000000000000000000000000000000000006',
    router: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
  },
  arbitrum: {
    usdc:   '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    weth:   '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    router: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
  },
  base: {
    usdc:   '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    weth:   '0x4200000000000000000000000000000000000006',
    router: '0x2626664c2603336E57B271c5C0b26F421741e481',
  }
} : {
  // Testnet addresses (Sepolia)
  optimism: {
    usdc:   '0x5fd84259d66Cd46123540766Be93DFE6D43130D7',
    weth:   '0x4200000000000000000000000000000000000006',
    router: '0xa132DAB612dB5cB9fC9Ac426A0Cc215A3423F9c9',
  },
  arbitrum: {
    usdc:   '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
    weth:   '0x980B62Da83eFf3D4576C647993b0c1D7faf17c73',
    router: '0x101F443B4d1b059569D643917553c771E1b9663E',
  },
  base: {
    usdc:   '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    weth:   '0x4200000000000000000000000000000000000006',
    router: '0x050E797f3625EC8785265e1d9BDd4799b97528A1',
  }
};

// RPC endpoints
const RPCS = MAINNET ? {
  optimism: 'https://mainnet.optimism.io',
  arbitrum: 'https://arb1.arbitrum.io/rpc',
  base:     'https://mainnet.base.org',
} : {
  optimism: 'https://sepolia.optimism.io',
  arbitrum: 'https://sepolia-rollup.arbitrum.io/rpc',
  base:     'https://sepolia.base.org',
};

// Trade size — start small for first live mainnet trades
const TRADE_USDC = 10_000000n; // $10 USDC (6 decimals)
const SLIPPAGE   = 50n;        // 0.5% minimum output

// Quoter ABI — simulates swap without executing
const QUOTER_ABI = [{
  name: 'quoteExactInputSingle',
  type: 'function',
  stateMutability: 'nonpayable',
  inputs: [{ type: 'tuple', components: [
    { name: 'tokenIn',           type: 'address' },
    { name: 'tokenOut',          type: 'address' },
    { name: 'amountIn',          type: 'uint256' },
    { name: 'fee',               type: 'uint24'  },
    { name: 'sqrtPriceLimitX96', type: 'uint160' },
  ]}],
  outputs: [
    { name: 'amountOut',         type: 'uint256' },
    { name: 'sqrtPriceX96After', type: 'uint160' },
    { name: 'initializedTicksCrossed', type: 'uint32' },
    { name: 'gasEstimate',       type: 'uint256' },
  ]
}];

const QUOTER_ADDRESSES = MAINNET ? {
  optimism: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  arbitrum: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  base:     '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
} : {
  optimism: '0xa132DAB612dB5cB9fC9Ac426A0Cc215A3423F9c9',
  arbitrum: '0x101F443B4d1b059569D643917553c771E1b9663E',
  base:     '0x050E797f3625EC8785265e1d9BDd4799b97528A1',
};

const SWAP_ABI = [
  {
    name: 'exactInputSingle',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ type: 'tuple', components: [
      { name: 'tokenIn',           type: 'address' },
      { name: 'tokenOut',          type: 'address' },
      { name: 'fee',               type: 'uint24'  },
      { name: 'recipient',         type: 'address' },
      { name: 'amountIn',          type: 'uint256' },
      { name: 'amountOutMinimum',  type: 'uint256' },
      { name: 'sqrtPriceLimitX96', type: 'uint160' },
    ]}],
    outputs: [{ type: 'uint256' }]
  }
];

const ERC20_ABI = [
  { name: 'approve',     type: 'function', stateMutability: 'nonpayable',
    inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { name: 'balanceOf',   type: 'function', stateMutability: 'view',
    inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
];

const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) { console.error('ERROR: PRIVATE_KEY not set'); process.exit(1); }

const SIGNAL_HMAC_HEX = process.env.PAXIOM_EXEC_SIGNAL_HMAC_KEY;
if (!SIGNAL_HMAC_HEX || Buffer.from(SIGNAL_HMAC_HEX, 'hex').length < 32) {
  console.error('ERROR: PAXIOM_EXEC_SIGNAL_HMAC_KEY required (>=32 bytes hex). ' +
    'Generate: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}
const SIGNAL_HMAC_KEY = Buffer.from(SIGNAL_HMAC_HEX, 'hex');
const SIGNAL_TS_WINDOW_MS = 30_000;
const SIGNAL_RATE_PER_MIN = 30;
const seenNonces = new Map();
let signalBucket = { count: 0, windowStart: Date.now() };

function verifySignal(req, raw) {
  const now = Date.now();
  if (now - signalBucket.windowStart > 60_000) signalBucket = { count: 0, windowStart: now };
  if (++signalBucket.count > SIGNAL_RATE_PER_MIN) return 'rate-limited';
  const ts = req.headers['x-paxiom-signal-ts'];
  const nonce = req.headers['x-paxiom-signal-nonce'];
  const sig = req.headers['x-paxiom-signal-hmac'];
  if (!ts || !nonce || !sig) return 'missing-headers';
  if (Math.abs(now - Number(ts)) > SIGNAL_TS_WINDOW_MS) return 'stale-timestamp';
  for (const [n, exp] of seenNonces) if (exp < now) seenNonces.delete(n);
  if (seenNonces.has(nonce)) return 'replay';
  if (seenNonces.size >= 10_000) return 'nonce-cap';
  let given;
  try { given = Buffer.from(sig, 'hex'); } catch { return 'bad-sig-hex'; }
  const expected = createHmac('sha256', SIGNAL_HMAC_KEY)
    .update(`${ts}.${nonce}.${raw}`).digest();
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return 'bad-sig';
  seenNonces.set(nonce, now + SIGNAL_TS_WINDOW_MS);
  return null;
}

const account    = privateKeyToAccount(`0x${PRIVATE_KEY.replace('0x','')}`);
import { optimism, arbitrum, base } from 'viem/chains';

const opChain   = MAINNET ? optimism        : optimismSepolia;
const baseChain = MAINNET ? base            : baseSepolia;
const arbChain  = MAINNET ? arbitrum        : arbitrumSepolia;

const walletOp   = createWalletClient({ account, chain: opChain,   transport: http(RPCS.optimism) });
const walletBase = createWalletClient({ account, chain: baseChain, transport: http(RPCS.base) });
const walletArb  = createWalletClient({ account, chain: arbChain,  transport: http(RPCS.arbitrum) });
const publicOp   = createPublicClient({ chain: opChain,            transport: http(RPCS.optimism) });
const publicBase = createPublicClient({ chain: baseChain,          transport: http(RPCS.base) });
const publicArb  = createPublicClient({ chain: arbChain,           transport: http(RPCS.arbitrum) });

// ─── FIX: centralised chain-to-client helpers ────────────────
// Single source of truth — no scattered ternary fallbacks.
function walletForChain(chainName) {
  if (chainName === 'optimism') return walletOp;
  if (chainName === 'base')     return walletBase;
  if (chainName === 'arbitrum') return walletArb;
  throw new Error(`Unknown chain for wallet: ${chainName}`);
}

function publicForChain(chainName) {
  if (chainName === 'optimism') return publicOp;
  if (chainName === 'base')     return publicBase;
  if (chainName === 'arbitrum') return publicArb;
  throw new Error(`Unknown chain for public client: ${chainName}`);
}
// ─────────────────────────────────────────────────────────────

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


async function quoteRealSpread(buyChainName, sellChainName, tradeUsdc) {
  try {
    const buyCfg  = CHAIN_CONFIG[buyChainName];
    const sellCfg = CHAIN_CONFIG[sellChainName];
    if (!buyCfg || !sellCfg) return null;

    const buyQuoterAddr  = QUOTER_ADDRESSES[buyChainName];
    const sellQuoterAddr = QUOTER_ADDRESSES[sellChainName];
    if (!buyQuoterAddr || !sellQuoterAddr) return null;

    const buyClient  = publicForChain(buyChainName);
    const sellClient = publicForChain(sellChainName);

    const buyQuote = await buyClient.simulateContract({
      address: buyQuoterAddr, abi: QUOTER_ABI,
      functionName: 'quoteExactInputSingle',
      args: [{ tokenIn: buyCfg.usdc, tokenOut: buyCfg.weth,
               amountIn: tradeUsdc, fee: 500, sqrtPriceLimitX96: 0n }]
    });

    const wethOut = buyQuote.result[0];

    const sellQuote = await sellClient.simulateContract({
      address: sellQuoterAddr, abi: QUOTER_ABI,
      functionName: 'quoteExactInputSingle',
      args: [{ tokenIn: sellCfg.weth, tokenOut: sellCfg.usdc,
               amountIn: wethOut, fee: 500, sqrtPriceLimitX96: 0n }]
    });

    const usdcIn    = Number(tradeUsdc) / 1e6;
    const usdcOut   = Number(sellQuote.result[0]) / 1e6;
    const realSpreadPct = ((usdcOut - usdcIn) / usdcIn) * 100;
    const netProfit = usdcOut - usdcIn - 0.50;

    return { usdcIn, usdcOut, realSpreadPct, netProfit, wethOut };
  } catch(e) {
    console.log('[QUOTE] Failed: ' + e.message.slice(0, 80));
    return null;
  }
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
    const buyChainName  = opp.buyChain  || 'optimism';
    const sellChainName = opp.sellChain || 'arbitrum';
    const buyCfg  = CHAIN_CONFIG[buyChainName];
    const sellCfg = CHAIN_CONFIG[sellChainName];

    if (!buyCfg || !sellCfg) {
      console.log(`[SKIP] Unknown chain in opportunity: ${buyChainName} / ${sellChainName}`);
      isExecuting = false;
      return false;
    }

    // ─── FIX: use helper for correct chain clients ────────────
    const buyWallet  = walletForChain(buyChainName);
    const sellWallet = walletForChain(sellChainName);
    const buyPublic  = publicForChain(buyChainName);
    // ─────────────────────────────────────────────────────────

    // Check USDC balance on buy side
    const usdcBal = await buyPublic.readContract({
      address: buyCfg.usdc, abi: ERC20_ABI,
      functionName: 'balanceOf', args: [account.address]
    });

    if (usdcBal < TRADE_USDC) {
      console.log('[SKIP] Insufficient USDC on ' + buyChainName + ': ' + usdcBal);
      isExecuting = false;
      return false;
    }

    // Build buy calldata — USDC → WETH on buy chain
    const buyCalldata = encodeFunctionData({
      abi: SWAP_ABI, functionName: 'exactInputSingle',
      args: [{ tokenIn: buyCfg.usdc, tokenOut: buyCfg.weth,
               fee: 500, recipient: account.address,
               amountIn: TRADE_USDC, amountOutMinimum: 0n,
               sqrtPriceLimitX96: 0n }]
    });

    // Approve USDC spend on buy side first
    const approveCalldata = encodeFunctionData({
      abi: ERC20_ABI, functionName: 'approve',
      args: [buyCfg.router, TRADE_USDC]
    });

    console.log('[SWAP] ' + buyChainName + ' buy USDC->ETH | ' + sellChainName + ' sell ETH->USDC');
    console.log('[SWAP] Trade size: $' + (Number(TRADE_USDC) / 1e6).toFixed(2) + ' USDC');

    // ─── FIX: quote must succeed — fail closed if unavailable ─
    console.log('[QUOTE] Checking real spread...');
    const quote = await quoteRealSpread(buyChainName, sellChainName, TRADE_USDC);
    if (!quote) {
      console.log('[SKIP] Quote unavailable — aborting execution (fail closed)');
      lastExecTime = Date.now();
      isExecuting = false;
      return false;
    }
    console.log(`[QUOTE] in: $${quote.usdcIn.toFixed(2)} out: $${quote.usdcOut.toFixed(4)} | real spread: ${quote.realSpreadPct.toFixed(4)}% | net: $${quote.netProfit.toFixed(4)}`);
    if (quote.netProfit <= 0) {
      console.log(`[SKIP] Real spread negative after price impact — not profitable, skipping`);
      lastExecTime = Date.now();
      isExecuting = false;
      return false;
    }
    console.log(`[QUOTE] Profitable — proceeding with execution`);
    // ─────────────────────────────────────────────────────────

    const t0 = Date.now();

    // Step 1 — approve on buy side (must precede swap)
    const approveNonce = await buyPublic.getTransactionCount({ address: account.address });
    const approveHash = await buyWallet.sendTransaction({
      to: buyCfg.usdc, data: approveCalldata, gas: 60000n, nonce: approveNonce
    });
    await buyPublic.waitForTransactionReceipt({ hash: approveHash, timeout: 30000 });

    // Step 2 — fetch fresh nonces after approve
    const [freshNonceOp, freshNonceBase, freshNonceArb] = await Promise.all([
      publicOp.getTransactionCount({ address: account.address }),
      publicBase.getTransactionCount({ address: account.address }),
      publicArb.getTransactionCount({ address: account.address }),
    ]);

    const buyNonce  = buyChainName === 'optimism'  ? freshNonceOp
                    : buyChainName === 'base'       ? freshNonceBase
                    : freshNonceArb;
    const sellNonce = sellChainName === 'arbitrum' ? freshNonceArb
                    : sellChainName === 'base'      ? freshNonceBase
                    : freshNonceOp;

    // ─── FIX: sell leg uses actual wethOut from the quote ─────
    // We now know exactly how much WETH the buy will produce.
    // Build sell calldata with real amountIn instead of 0n.
    const sellCalldata = encodeFunctionData({
      abi: SWAP_ABI, functionName: 'exactInputSingle',
      args: [{ tokenIn: sellCfg.weth, tokenOut: sellCfg.usdc,
               fee: 500, recipient: account.address,
               amountIn: quote.wethOut,
               amountOutMinimum: 0n,
               sqrtPriceLimitX96: 0n }]
    });
    // ─────────────────────────────────────────────────────────

    // Fire both swaps simultaneously
    const [chainAHash, chainBHash] = await Promise.all([
      buyWallet.sendTransaction({
        to: buyCfg.router, data: buyCalldata, gas: 200000n,
        nonce: buyNonce
      }),
      sellWallet.sendTransaction({
        to: sellCfg.router, data: sellCalldata, gas: 200000n,
        nonce: sellNonce
      })
    ]);
    const timingGapMs = Date.now() - t0;
    lastExecTime = Date.now();
    const opEtherscan  = process.env.MAINNET === 'true' ? 'https://optimistic.etherscan.io'  : 'https://sepolia-optimism.etherscan.io';
    const baseScan     = process.env.MAINNET === 'true' ? 'https://basescan.org'             : 'https://sepolia.basescan.org';
    console.log(`OP:   ${opEtherscan}/tx/${chainAHash}`);
    console.log(`Base: ${baseScan}/tx/${chainBHash}`);
    logExecution({ source, asset: opp.asset, spreadPct: opp.spreadPct,
      buyChain: opp.buyChain, sellChain: opp.sellChain,
      chainATxHash: chainAHash, chainBTxHash: chainBHash,
      timingGapMs, status: 'broadcast_success',
      estimatedProfit: quote.netProfit });
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
        const reject = verifySignal(req, body);
        if (reject) {
          console.warn(`[SIGNAL DENY] ${reject} from ${req.socket.remoteAddress}`);
          res.writeHead(401); res.end(JSON.stringify({ error: reject })); return;
        }
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
