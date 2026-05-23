import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { createServer } from 'http';
import { dirname } from 'path';
import { randomUUID } from 'crypto';
import { createWalletClient, createPublicClient, http, parseEther, encodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { optimismSepolia, baseSepolia, arbitrumSepolia } from 'viem/chains';

const PAXIOM_DIR     = process.env.PAXIOM_DIR || `${process.env.HOME}/paxiom`;
const LOG_FILE       = process.env.LOG_FILE  || `${PAXIOM_DIR}/opportunities.log`;
const EXEC_LOG       = process.env.EXEC_LOG  || `${PAXIOM_DIR}/execution.log`;
// Persistent dedup state: opportunity id (timestamp + asset + route) of the last
// scanner row consumed. Survives executor restarts so we never double-fire on
// an opp that was already acted on.
const STATE_DIR      = process.env.EXEC_STATE_DIR || `${PAXIOM_DIR}/.executor`;
const STATE_FILE     = process.env.EXEC_STATE_FILE || `${STATE_DIR}/last-consumed.json`;
const KILL_FILE      = process.env.KILL_FILE || '/tmp/paxiom-kill';
// Spread threshold (in percent — 0.30 = 0.30% = 30 bps). Default 0.30%
// clears 0.10% Uniswap V3 round-trip pool fees + gas at $1k size with margin.
const MIN_SPREAD     = Number(process.env.PAXIOM_MIN_SPREAD || 0.30);
const CHECK_INTERVAL = 15000;
const COOLDOWN_MS    = 60000;
const HTTP_PORT      = 7070;

// ─── chain config ────────────────────────────────────────────
// MAINNET=true|1 in env switches to mainnet RPCs and token addresses.
// arb-runner spawns this with MAINNET=true; default is testnet for safety.
const MAINNET = process.env.MAINNET === 'true' || process.env.MAINNET === '1';
console.log(`[CONFIG] network=${MAINNET ? 'MAINNET' : 'testnet'}`);

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

// Trade size — start small for first live mainnet trades.
// Set PAXIOM_TRADE_SIZE_USDC in whole dollars (default $1,000 for Tier A live test).
const TRADE_DOLLARS = Number(process.env.PAXIOM_TRADE_SIZE_USDC || 1000);
const TRADE_USDC = BigInt(TRADE_DOLLARS) * 1_000000n;
const SLIPPAGE_BPS = BigInt(Number(process.env.PAXIOM_SLIPPAGE_BPS || 50)); // 50 bps = 0.5%
const SLIPPAGE_DENOM = 10000n;
console.log(`[CONFIG] trade=$${TRADE_DOLLARS.toLocaleString()} slippage=${SLIPPAGE_BPS}bps`);

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

function explorerTxUrl(chainName, hash) {
  const base = MAINNET
    ? { optimism: 'https://optimistic.etherscan.io', base: 'https://basescan.org', arbitrum: 'https://arbiscan.io' }
    : { optimism: 'https://sepolia-optimism.etherscan.io', base: 'https://sepolia.basescan.org', arbitrum: 'https://sepolia.arbiscan.io' };
  return `${base[chainName]}/tx/${hash}`;
}
// ─────────────────────────────────────────────────────────────

let lastConsumedOppId = '';
let lastExecTime = 0;
let execCount    = 0;
let isExecuting  = false;

// Deterministic id for an opportunity row from the scanner. Same logical opp
// produces the same id regardless of who reads it — used for dedup + linkage.
function opportunityId(opp) {
  return `${opp.timestamp}|${opp.asset}|${opp.buyChain}->${opp.sellChain}|${opp.spreadPct}`;
}

// Load persistent dedup state — what was the last opp id we consumed?
try {
  if (existsSync(STATE_FILE)) {
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    lastConsumedOppId = s.lastConsumedOppId || '';
    console.log(`[DEDUP] resumed: lastConsumedOppId=${lastConsumedOppId || '(none)'}`);
  } else if (existsSync(LOG_FILE)) {
    // First run after this dedup format was added — initialize to the most recent
    // opp so we don't replay history.
    const _lines = readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
    if (_lines.length) {
      const latest = JSON.parse(_lines[_lines.length - 1]);
      lastConsumedOppId = opportunityId(latest);
      console.log(`[DEDUP] initialized to most-recent log row: ${lastConsumedOppId}`);
    }
  }
} catch (e) { console.error(`[DEDUP] state load failed: ${e.message}`); }

function persistConsumed(oppId) {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify({
      lastConsumedOppId: oppId, updatedAt: new Date().toISOString(),
    }));
  } catch (e) { console.error(`[DEDUP] persist failed: ${e.message}`); }
}

function logExecution(entry) {
  // Coherent trade record — a single line with both legs, the source opp id,
  // and the source scanner timestamp. Downstream readers (unwind monitor, UI,
  // performance analytics) link buy/sell back to one trade by tradeId.
  const record = {
    timestamp: new Date().toISOString(),
    tradeId: entry.tradeId || randomUUID(),
    opportunityId: entry.opportunityId,
    sourceTimestamp: entry.sourceTimestamp,
    ...entry,
  };
  appendFileSync(EXEC_LOG, JSON.stringify(record) + '\n');
  console.log(`\n${'='.repeat(62)}`);
  console.log(`[${entry.source ?? 'POLL'} #${execCount}] trade=${record.tradeId.slice(0, 8)} opp=${(record.opportunityId || '').slice(0, 60)}`);
  console.log(`Asset:  ${entry.asset} ${entry.spreadPct}%`);
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
  const tradeId = randomUUID();
  const oppId = opportunityId(opp);
  if (existsSync(KILL_FILE)) {
    console.log(`[KILL] ${KILL_FILE} present — refusing to execute`);
    return false;
  }
  if (isExecuting) return false;
  const now = Date.now();
  if (lastExecTime > 0 && now - lastExecTime < COOLDOWN_MS) {
    const remaining = Math.round((COOLDOWN_MS - (now - lastExecTime)) / 1000);
    console.log(`[COOLDOWN] ${remaining}s remaining`);
    return false;
  }
  // Stale-quote guard — reject opportunities older than 5s
  if (opp.timestamp) {
    const ageMs = now - new Date(opp.timestamp).getTime();
    if (ageMs > 5000) {
      console.log(`[SKIP] opportunity stale (${ageMs}ms > 5000ms)`);
      return false;
    }
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

    // Cross-chain only — same-chain arb is the MEV-saturated lane and structurally
    // not winnable for a non-co-located operator. Refuse same-chain opportunities
    // regardless of how they got here (scanner, AO signal, manual POST).
    if (buyChainName === sellChainName) {
      console.log(`[REJECT] Same-chain opportunity refused (${buyChainName}). Cross-chain only — see project_paxiom_arb_design.`);
      logExecution({ tradeId, opportunityId: oppId, sourceTimestamp: opp.timestamp,
        source, asset: opp.asset, spreadPct: opp.spreadPct,
        buyChain: opp.buyChain, sellChain: opp.sellChain,
        chainATxHash: 'REFUSED: same-chain (MEV lane)',
        chainBTxHash: 'not reached', timingGapMs: 0,
        status: 'rejected_same_chain', estimatedProfit: 0 });
      isExecuting = false;
      return false;
    }

    // ─── FIX: use helper for correct chain clients ────────────
    const buyWallet  = walletForChain(buyChainName);
    const sellWallet = walletForChain(sellChainName);
    const buyPublic  = publicForChain(buyChainName);
    // ─────────────────────────────────────────────────────────

    // Check USDC balance on buy side AND WETH balance on sell side in parallel.
    // The sell leg is WETH→USDC on `sellChain`, so we need WETH pre-positioned there.
    const sellPublic = publicForChain(sellChainName);
    const [usdcBal, wethBal] = await Promise.all([
      buyPublic.readContract({  address: buyCfg.usdc,  abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }),
      sellPublic.readContract({ address: sellCfg.weth, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }),
    ]);

    if (usdcBal < TRADE_USDC) {
      console.log('[SKIP] Insufficient USDC on ' + buyChainName + ': ' + usdcBal);
      isExecuting = false;
      return false;
    }
    // WETH check uses a conservative bound: we need at least the wethOut from the
    // upcoming quote. Pre-quote we don't know exact size, so require WETH equivalent
    // to the trade-size USDC at $2k/ETH (deliberately low ETH price → larger WETH bound).
    const minWeth = (TRADE_USDC * 10n ** 18n) / (2000n * 10n ** 6n);
    if (wethBal < minWeth) {
      console.log(`[SKIP] Insufficient WETH on ${sellChainName}: ${wethBal} (need ~${minWeth})`);
      isExecuting = false;
      return false;
    }

    // (buy calldata is built below, after the quote, so we can use a real
    // amountOutMinimum derived from quote.wethOut)

    // Build BOTH approvals — buy router for USDC on buyChain AND sell router for
    // WETH on sellChain. Without the sell-side approval the WETH→USDC swap reverts
    // with "ERC20: insufficient allowance".
    const MAX_UINT = (1n << 256n) - 1n;
    const approveBuyCalldata = encodeFunctionData({
      abi: ERC20_ABI, functionName: 'approve',
      args: [buyCfg.router, MAX_UINT]
    });
    const approveSellCalldata = encodeFunctionData({
      abi: ERC20_ABI, functionName: 'approve',
      args: [sellCfg.router, MAX_UINT]
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

    // Step 1 — approvals on BOTH chains in parallel (must precede swap).
    // Idempotent: re-approving with MAX_UINT is a no-op after the first time, but
    // we don't track approval state so we always send. Cost: ~$0.05 gas per chain.
    // OPTIMIZATION: cache approved-set in memory to skip after first run.
    const [buyApproveNonce, sellApproveNonce] = await Promise.all([
      buyPublic.getTransactionCount({ address: account.address }),
      sellPublic.getTransactionCount({ address: account.address }),
    ]);
    const [approveBuyHash, approveSellHash] = await Promise.all([
      buyWallet.sendTransaction({  to: buyCfg.usdc,  data: approveBuyCalldata,  gas: 60000n, nonce: buyApproveNonce  }),
      sellWallet.sendTransaction({ to: sellCfg.weth, data: approveSellCalldata, gas: 60000n, nonce: sellApproveNonce }),
    ]);
    await Promise.all([
      buyPublic.waitForTransactionReceipt({  hash: approveBuyHash,  timeout: 30000 }),
      sellPublic.waitForTransactionReceipt({ hash: approveSellHash, timeout: 30000 }),
    ]);

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

    // ─── Build calldata for both legs using quote outputs ─────
    // Both legs get real amountOutMinimum derived from the quote with SLIPPAGE_BPS
    // tolerance. If MEV moves the price more than SLIPPAGE_BPS, the swap reverts
    // and we burn gas instead of trading at a worse price.
    const buyMinOut  = (quote.wethOut * (SLIPPAGE_DENOM - SLIPPAGE_BPS)) / SLIPPAGE_DENOM;
    const sellMinOut = (BigInt(Math.floor(quote.usdcOut * 1e6)) * (SLIPPAGE_DENOM - SLIPPAGE_BPS)) / SLIPPAGE_DENOM;

    const buyCalldata = encodeFunctionData({
      abi: SWAP_ABI, functionName: 'exactInputSingle',
      args: [{ tokenIn: buyCfg.usdc, tokenOut: buyCfg.weth,
               fee: 500, recipient: account.address,
               amountIn: TRADE_USDC, amountOutMinimum: buyMinOut,
               sqrtPriceLimitX96: 0n }]
    });
    const sellCalldata = encodeFunctionData({
      abi: SWAP_ABI, functionName: 'exactInputSingle',
      args: [{ tokenIn: sellCfg.weth, tokenOut: sellCfg.usdc,
               fee: 500, recipient: account.address,
               amountIn: quote.wethOut, amountOutMinimum: sellMinOut,
               sqrtPriceLimitX96: 0n }]
    });
    console.log(`[SLIP] buyMinOut=${buyMinOut} (WETH wei)  sellMinOut=${sellMinOut} (USDC base)`);
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
    console.log(`${buyChainName}:  ${explorerTxUrl(buyChainName, chainAHash)}`);
    console.log(`${sellChainName}: ${explorerTxUrl(sellChainName, chainBHash)}`);
    logExecution({ tradeId, opportunityId: oppId, sourceTimestamp: opp.timestamp,
      source, asset: opp.asset, spreadPct: opp.spreadPct,
      buyChain: opp.buyChain, sellChain: opp.sellChain,
      chainATxHash: chainAHash, chainBTxHash: chainBHash,
      timingGapMs, status: 'broadcast_success',
      estimatedProfit: quote.netProfit });
    // Wait for receipts on the actual buy/sell chains, not hardcoded ones.
    Promise.all([
      buyPublic.waitForTransactionReceipt({  hash: chainAHash, timeout: 30000 }),
      sellPublic.waitForTransactionReceipt({ hash: chainBHash, timeout: 30000 })
    ]).then(([a, b]) => console.log(`Confirmed ${buyChainName} block ${a.blockNumber} | ${sellChainName} block ${b.blockNumber}`))
      .catch(() => console.log('Confirmation timeout'));
    return { chainAHash, chainBHash, timingGapMs };
  } catch(e) {
    console.error(`Error: ${e.message.slice(0, 120)}`);
    logExecution({ tradeId, opportunityId: oppId, sourceTimestamp: opp.timestamp,
      source, asset: opp.asset, spreadPct: opp.spreadPct,
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
  if (existsSync(KILL_FILE)) return;
  if (isExecuting) return;
  try {
    const content = readFileSync(LOG_FILE, 'utf8');
    const lines   = content.trim().split('\n').filter(l => l.trim());
    const recent  = lines.slice(-3).map(l => JSON.parse(l));
    const now = Date.now();
    if (lastExecTime > 0 && now - lastExecTime < COOLDOWN_MS) return;

    for (const opp of recent) {
      const oppId = opportunityId(opp);
      // Strict consume-once: dedup against the last persisted oppId.
      if (oppId === lastConsumedOppId) continue;
      if (parseFloat(opp.spreadPct) < MIN_SPREAD) continue;
      if (!opp.capturable) continue;
      // Stale guard already in executeLive; this also skips opps older than 30s
      // outright since they can't be re-quoted profitably.
      const ageMs = now - new Date(opp.timestamp).getTime();
      if (ageMs > 30_000) continue;
      // Mark consumed BEFORE attempting — protects against a runaway loop on
      // the same opp if executeLive itself errors mid-flight.
      lastConsumedOppId = oppId;
      persistConsumed(oppId);
      await executeLive(opp, 'POLL');
      break;
    }
  } catch(e) {
    // Swallow the read error if the log doesn't exist yet (scanner not running).
  }
}

console.log('Paxiom Live Executor — Testnet Broadcast');
console.log(`Wallet: ${account.address}`);
console.log(`Min spread: ${MIN_SPREAD}%  Cooldown: ${COOLDOWN_MS/1000}s  Port: ${HTTP_PORT}\n`);

setInterval(poll, CHECK_INTERVAL);
poll();
