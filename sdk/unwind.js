// Half-fill detector and (optional) unwind helper for Path B cross-chain trades.
//
// Reads execution.log entries written by live-executor.js, fetches both leg
// receipts, classifies the outcome, and appends a structured record to unwind.log.
// Detection only by default; pass --auto-unwind to also fire a corrective swap on
// the half-filled chain (still gated by per-attempt size + cooldown).
//
// Usage:
//   PRIVATE_KEY=0x... node sdk/unwind.js                         # detect-only
//   PRIVATE_KEY=0x... node sdk/unwind.js --auto-unwind            # also act
//   PRIVATE_KEY=0x... MAINNET=1 node sdk/unwind.js                # mainnet RPCs
//
// Designed to run as a sidecar to live-executor.js — read-only on execution.log,
// writes to unwind.log only.

import { readFileSync, appendFileSync, existsSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
  createPublicClient, createWalletClient, http,
  encodeFunctionData,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  optimism, arbitrum, base,
  optimismSepolia, arbitrumSepolia, baseSepolia,
} from 'viem/chains';

// ─── config ───────────────────────────────────────────────────
const PAXIOM_DIR    = process.env.PAXIOM_DIR || join(homedir(), 'paxiom');
const EXEC_LOG      = process.env.EXEC_LOG   || join(PAXIOM_DIR, 'execution.log');
const UNWIND_LOG    = process.env.UNWIND_LOG || join(PAXIOM_DIR, 'unwind.log');
const KILL_FILE     = process.env.KILL_FILE  || '/tmp/paxiom-kill';
const POLL_MS       = Number(process.env.POLL_MS || 30_000);
const RECEIPT_TIMEOUT_MS = Number(process.env.RECEIPT_TIMEOUT_MS || 90_000);
const MAINNET       = process.env.MAINNET === '1' || process.env.MAINNET === 'true';
const AUTO_UNWIND   = process.argv.includes('--auto-unwind');

const RPCS = MAINNET ? {
  optimism: process.env.RPC_OPTIMISM || 'https://mainnet.optimism.io',
  arbitrum: process.env.RPC_ARBITRUM || 'https://arb1.arbitrum.io/rpc',
  base:     process.env.RPC_BASE     || 'https://mainnet.base.org',
} : {
  optimism: 'https://sepolia.optimism.io',
  arbitrum: 'https://sepolia-rollup.arbitrum.io/rpc',
  base:     'https://sepolia.base.org',
};

const TOKENS = MAINNET ? {
  optimism: { usdc: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', weth: '0x4200000000000000000000000000000000000006', router: '0xE592427A0AEce92De3Edee1F18E0157C05861564' },
  arbitrum: { usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', weth: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', router: '0xE592427A0AEce92De3Edee1F18E0157C05861564' },
  base:     { usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', weth: '0x4200000000000000000000000000000000000006', router: '0x2626664c2603336E57B271c5C0b26F421741e481' },
} : {
  optimism: { usdc: '0x5fd84259d66Cd46123540766Be93DFE6D43130D7', weth: '0x4200000000000000000000000000000000000006', router: '0xa132DAB612dB5cB9fC9Ac426A0Cc215A3423F9c9' },
  arbitrum: { usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', weth: '0x980B62Da83eFf3D4576C647993b0c1D7faf17c73', router: '0x101F443B4d1b059569D643917553c771E1b9663E' },
  base:     { usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', weth: '0x4200000000000000000000000000000000000006', router: '0x050E797f3625EC8785265e1d9BDd4799b97528A1' },
};

const SWAP_ABI = [{
  name: 'exactInputSingle', type: 'function', stateMutability: 'nonpayable',
  inputs: [{ type: 'tuple', components: [
    { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' },
    { name: 'fee', type: 'uint24' }, { name: 'recipient', type: 'address' },
    { name: 'amountIn', type: 'uint256' }, { name: 'amountOutMinimum', type: 'uint256' },
    { name: 'sqrtPriceLimitX96', type: 'uint160' },
  ]}],
  outputs: [{ type: 'uint256' }],
}];
const ERC20_ABI = [
  { name: 'approve', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
];

// ─── colors ───────────────────────────────────────────────────
const RESET = '\x1b[0m', BOLD = '\x1b[1m', DIM = '\x1b[2m';
const RED = '\x1b[31m', GREEN = '\x1b[32m', YELLOW = '\x1b[33m', CYAN = '\x1b[36m';

// ─── chain client setup ───────────────────────────────────────
const chainObjFor = (name) => {
  const m = MAINNET ? { optimism, arbitrum, base } : { optimism: optimismSepolia, arbitrum: arbitrumSepolia, base: baseSepolia };
  return m[name];
};
const publicClients = Object.fromEntries(
  ['optimism', 'arbitrum', 'base'].map(c => [c, createPublicClient({ chain: chainObjFor(c), transport: http(RPCS[c]) })])
);

let walletClients = null;
let account = null;
if (AUTO_UNWIND) {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) { console.error(`${RED}--auto-unwind requires PRIVATE_KEY${RESET}`); process.exit(1); }
  account = privateKeyToAccount(`0x${pk.replace('0x', '')}`);
  walletClients = Object.fromEntries(
    ['optimism', 'arbitrum', 'base'].map(c => [c, createWalletClient({ account, chain: chainObjFor(c), transport: http(RPCS[c]) })])
  );
}

// ─── classification ───────────────────────────────────────────
async function fetchReceipt(chainName, txHash) {
  if (!txHash || typeof txHash !== 'string' || !txHash.startsWith('0x')) {
    return { state: 'invalid_hash', reason: txHash };
  }
  try {
    const r = await publicClients[chainName].waitForTransactionReceipt({
      hash: txHash, timeout: RECEIPT_TIMEOUT_MS,
    });
    return { state: r.status === 'success' ? 'success' : 'reverted', receipt: r };
  } catch (e) {
    return { state: 'no_receipt', reason: e.message.slice(0, 120) };
  }
}

function classify(buyResult, sellResult) {
  const buyOk  = buyResult.state === 'success';
  const sellOk = sellResult.state === 'success';
  if (buyOk && sellOk)   return 'BOTH_OK';
  if (!buyOk && !sellOk) return 'BOTH_FAIL';
  if (buyOk && !sellOk)  return 'HALF_BUY';
  return 'HALF_SELL';
}

// ─── unwind action (auto mode) ────────────────────────────────
// HALF_BUY = bought WETH on buyChain, sell-leg never landed.
//   Unwind = sell that WETH back to USDC on the SAME buyChain.
//   Cost: ~0.10% fees + slippage. Locks in a small loss but flattens inventory.
// HALF_SELL = sold WETH on sellChain, buy-leg never landed.
//   Unwind = buy WETH back on the SAME sellChain.
//   Same ~0.10% fee cost.
// Quoter addresses + ABI (Uniswap V3 QuoterV2). Re-declared here to keep this
// file standalone (sdk/ scripts don't share a module).
const QUOTERS_UNWIND = {
  optimism: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  arbitrum: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  base:     '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
};
const QUOTER_ABI_UNWIND = [{
  name: 'quoteExactInputSingle', type: 'function', stateMutability: 'nonpayable',
  inputs: [{ type: 'tuple', components: [
    { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' },
    { name: 'amountIn', type: 'uint256' }, { name: 'fee', type: 'uint24' },
    { name: 'sqrtPriceLimitX96', type: 'uint160' },
  ]}],
  outputs: [
    { name: 'amountOut', type: 'uint256' }, { name: 'sqrtPriceX96After', type: 'uint160' },
    { name: 'initializedTicksCrossed', type: 'uint32' }, { name: 'gasEstimate', type: 'uint256' },
  ],
}];

const UNWIND_SLIPPAGE_BPS = BigInt(Number(process.env.PAXIOM_UNWIND_SLIPPAGE_BPS || 100)); // 1% default
const SLIPPAGE_DENOM_U = 10000n;

async function autoUnwind(category, entry) {
  if (!AUTO_UNWIND) return { acted: false, reason: 'auto-unwind disabled (manual recovery only)' };
  if (category !== 'HALF_BUY' && category !== 'HALF_SELL') {
    return { acted: false, reason: 'no unwind needed for ' + category };
  }
  if (existsSync(KILL_FILE)) return { acted: false, reason: 'kill file present' };

  const chainName = category === 'HALF_BUY' ? entry.buyChain : entry.sellChain;
  const cfg = TOKENS[chainName];
  if (!cfg) return { acted: false, reason: 'unknown chain ' + chainName };
  const quoterAddr = QUOTERS_UNWIND[chainName];
  if (!quoterAddr) return { acted: false, reason: 'no quoter for ' + chainName };

  const TRADE_USDC = 1000_000000n;
  const APPROX_WETH = (TRADE_USDC * 10n ** 18n) / (2500n * 10n ** 6n);

  const { tokenIn, tokenOut, amountIn } = category === 'HALF_BUY'
    ? { tokenIn: cfg.weth, tokenOut: cfg.usdc, amountIn: APPROX_WETH }
    : { tokenIn: cfg.usdc, tokenOut: cfg.weth, amountIn: TRADE_USDC };

  // Quote the corrective swap so we can set a real amountOutMinimum. If the quote
  // fails or the resulting min-out can't be satisfied at execution, the swap reverts
  // (gas-only loss) instead of executing at a sandwich-degraded price.
  let quote;
  try {
    quote = await publicClients[chainName].simulateContract({
      address: quoterAddr, abi: QUOTER_ABI_UNWIND, functionName: 'quoteExactInputSingle',
      args: [{ tokenIn, tokenOut, amountIn, fee: 500, sqrtPriceLimitX96: 0n }],
    });
  } catch (e) {
    console.log(`${RED}[UNWIND] quote failed — refusing to swap unbounded: ${e.message.slice(0, 120)}${RESET}`);
    return { acted: false, reason: 'quote_failed: ' + e.message.slice(0, 120) };
  }
  const expectedOut = quote.result[0];
  const minOut = (expectedOut * (SLIPPAGE_DENOM_U - UNWIND_SLIPPAGE_BPS)) / SLIPPAGE_DENOM_U;

  const approveCalldata = encodeFunctionData({
    abi: ERC20_ABI, functionName: 'approve', args: [cfg.router, amountIn],
  });
  const swapCalldata = encodeFunctionData({
    abi: SWAP_ABI, functionName: 'exactInputSingle',
    args: [{
      tokenIn, tokenOut, fee: 500,
      recipient: account.address,
      amountIn,
      amountOutMinimum: minOut,
      sqrtPriceLimitX96: 0n,
    }],
  });

  console.log(`${YELLOW}[UNWIND] ${category} on ${chainName} — corrective swap (slippage ≤${UNWIND_SLIPPAGE_BPS}bps, minOut=${minOut})${RESET}`);
  try {
    const approveHash = await walletClients[chainName].sendTransaction({
      to: tokenIn, data: approveCalldata, gas: 60000n,
    });
    await publicClients[chainName].waitForTransactionReceipt({ hash: approveHash, timeout: 30000 });
    const swapHash = await walletClients[chainName].sendTransaction({
      to: cfg.router, data: swapCalldata, gas: 200000n,
    });
    await publicClients[chainName].waitForTransactionReceipt({ hash: swapHash, timeout: 30000 });
    console.log(`${GREEN}[UNWIND] complete: ${swapHash}${RESET}`);
    return { acted: true, swapHash, approveHash, expectedOut: expectedOut.toString(), minOut: minOut.toString() };
  } catch (e) {
    console.log(`${RED}[UNWIND] failed: ${e.message.slice(0, 120)}${RESET}`);
    return { acted: false, reason: 'tx failed: ' + e.message.slice(0, 120) };
  }
}

// ─── main loop ────────────────────────────────────────────────
const processed = new Set();

function loadProcessed() {
  if (!existsSync(UNWIND_LOG)) return;
  for (const line of readFileSync(UNWIND_LOG, 'utf8').split('\n').filter(Boolean)) {
    try { processed.add(JSON.parse(line).execTimestamp); } catch {}
  }
}

function loadExecEntries() {
  if (!existsSync(EXEC_LOG)) return [];
  return readFileSync(EXEC_LOG, 'utf8').split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

async function processEntry(entry) {
  if (processed.has(entry.timestamp)) return;
  // Only inspect entries that claimed broadcast success — error entries already failed.
  if (entry.status !== 'broadcast_success') {
    processed.add(entry.timestamp);
    return;
  }

  const buyChain  = entry.buyChain;
  const sellChain = entry.sellChain;
  if (!TOKENS[buyChain] || !TOKENS[sellChain]) {
    processed.add(entry.timestamp);
    return;
  }

  let buyResult, sellResult, category;
  // Test-mode backdoor: synthetic entries with a forcedCategory skip receipt
  // fetching and route directly through to logging + UI. Used by the runner's
  // /v1/runner/test-half-fill endpoint to verify the detection wiring.
  if (entry.synthetic === true && entry.forcedCategory) {
    category = entry.forcedCategory;
    buyResult = {
      state: category === 'BOTH_OK' || category === 'HALF_BUY' ? 'success' : 'no_receipt',
      synthetic: true,
    };
    sellResult = {
      state: category === 'BOTH_OK' || category === 'HALF_SELL' ? 'success' : 'no_receipt',
      synthetic: true,
    };
    console.log(`${YELLOW}[SYNTHETIC] forced category ${category} for trade ${entry.tradeId || entry.timestamp}${RESET}`);
  } else {
    [buyResult, sellResult] = await Promise.all([
      fetchReceipt(buyChain,  entry.chainATxHash),
      fetchReceipt(sellChain, entry.chainBTxHash),
    ]);
    category = classify(buyResult, sellResult);
  }

  let unwindResult = { acted: false };
  if (category === 'HALF_BUY' || category === 'HALF_SELL') {
    unwindResult = await autoUnwind(category, entry);
  }

  const record = {
    detectedAt: new Date().toISOString(),
    execTimestamp: entry.timestamp,
    tradeId: entry.tradeId || null,
    opportunityId: entry.opportunityId || null,
    sourceTimestamp: entry.sourceTimestamp || null,
    synthetic: entry.synthetic === true,
    asset: entry.asset, spreadPct: entry.spreadPct,
    buyChain, sellChain,
    category,
    buyTx: { hash: entry.chainATxHash, ...buyResult },
    sellTx: { hash: entry.chainBTxHash, ...sellResult },
    unwind: unwindResult,
  };
  // Strip viem receipt blob — too verbose for line-oriented log.
  if (record.buyTx.receipt)  record.buyTx  = { ...record.buyTx,  blockNumber: String(record.buyTx.receipt.blockNumber),  receipt: undefined };
  if (record.sellTx.receipt) record.sellTx = { ...record.sellTx, blockNumber: String(record.sellTx.receipt.blockNumber), receipt: undefined };

  appendFileSync(UNWIND_LOG, JSON.stringify(record) + '\n');
  processed.add(entry.timestamp);

  const color = category === 'BOTH_OK'  ? GREEN
              : category === 'BOTH_FAIL' ? DIM
              : category === 'HALF_BUY' || category === 'HALF_SELL' ? RED
              : YELLOW;
  console.log(`${color}[${category}]${RESET} ${entry.timestamp} ${entry.asset} ${entry.spreadPct}% ${buyChain}->${sellChain}` +
              (unwindResult.acted ? ` ${YELLOW}(unwind: ${unwindResult.swapHash || unwindResult.reason})${RESET}` : ''));
}

async function tick() {
  if (existsSync(KILL_FILE)) { console.log(`${YELLOW}[KILL] ${KILL_FILE} present — exiting${RESET}`); process.exit(0); }
  const entries = loadExecEntries();
  for (const entry of entries) {
    try { await processEntry(entry); }
    catch (e) { console.log(`${RED}[ERR] ${entry.timestamp}: ${e.message.slice(0, 120)}${RESET}`); }
  }
}

console.log(`${BOLD}${CYAN}Paxiom unwind monitor${RESET}`);
console.log(`  exec log:    ${EXEC_LOG}`);
console.log(`  unwind log:  ${UNWIND_LOG}`);
console.log(`  mode:        ${MAINNET ? 'mainnet' : 'testnet'}`);
console.log(`  auto-unwind: ${AUTO_UNWIND ? `${YELLOW}ENABLED${RESET}` : 'disabled (detect-only)'}`);
console.log(`  poll:        every ${POLL_MS / 1000}s`);
console.log(`  kill file:   ${KILL_FILE}`);
console.log('');

loadProcessed();
console.log(`${DIM}Resumed: ${processed.size} entries already processed${RESET}\n`);
tick();
setInterval(tick, POLL_MS);
