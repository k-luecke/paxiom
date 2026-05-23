// Single-shot mainnet test trade. Reads the operator key from the arb-runner
// store, runs ONE cross-chain arb attempt, prints every step, and exits.
//
// Hard limits for safety:
//   - $200 max trade size (anti fat-finger)
//   - mainnet only — no testnet path
//   - requires interactive 'yes' before any broadcast (or --yes flag)
//   - aborts if quote shows non-positive net profit (override with --force)
//
// Usage:
//   node sdk/test-trade.js --buy optimism --sell base --size 50
//   node sdk/test-trade.js --buy base --sell arbitrum --size 50 --yes
//   node sdk/test-trade.js --buy optimism --sell base --size 50 --force
//
// Reads operator key from $PAXIOM_DIR/.arb-runner/operator.key (default
// ~/paxiom/.arb-runner/operator.key) — same file the engine uses.

import { readFileSync, existsSync, appendFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createInterface } from 'readline';
import {
  createPublicClient, createWalletClient, http, encodeFunctionData,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { optimism, arbitrum, base } from 'viem/chains';

// ─── args ─────────────────────────────────────────────────────
const args = process.argv.slice(2);
function arg(name, dflt) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
}
const flag = (name) => args.includes(`--${name}`);

const BUY_CHAIN  = (arg('buy')  || 'optimism').toLowerCase();
const SELL_CHAIN = (arg('sell') || 'base').toLowerCase();
const SIZE_USD   = Number(arg('size', '50'));
const SLIPPAGE_BPS = BigInt(arg('slippage', '50'));
const SLIPPAGE_DENOM = 10000n;
const NON_INTERACTIVE = flag('yes');
const FORCE_UNPROFITABLE = flag('force');
const MAX_SIZE_USD = 200;

if (!['optimism', 'base', 'arbitrum'].includes(BUY_CHAIN))  fatal(`unknown buy chain: ${BUY_CHAIN}`);
if (!['optimism', 'base', 'arbitrum'].includes(SELL_CHAIN)) fatal(`unknown sell chain: ${SELL_CHAIN}`);
if (BUY_CHAIN === SELL_CHAIN) fatal('buy and sell chain must differ');
if (!Number.isFinite(SIZE_USD) || SIZE_USD <= 0)  fatal('size must be positive number');
if (SIZE_USD > MAX_SIZE_USD) fatal(`size $${SIZE_USD} exceeds hard cap $${MAX_SIZE_USD}`);

// ─── config (mainnet only) ───────────────────────────────────
const RPCS = {
  optimism: process.env.RPC_OPTIMISM || 'https://mainnet.optimism.io',
  arbitrum: process.env.RPC_ARBITRUM || 'https://arb1.arbitrum.io/rpc',
  base:     process.env.RPC_BASE     || 'https://mainnet.base.org',
};
const TOKENS = {
  optimism: { usdc: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', weth: '0x4200000000000000000000000000000000000006', router: '0xE592427A0AEce92De3Edee1F18E0157C05861564' },
  arbitrum: { usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', weth: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', router: '0xE592427A0AEce92De3Edee1F18E0157C05861564' },
  base:     { usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', weth: '0x4200000000000000000000000000000000000006', router: '0x2626664c2603336E57B271c5C0b26F421741e481' },
};
const QUOTERS = {
  optimism: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  arbitrum: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  base:     '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
};
const EXPLORERS = {
  optimism: 'https://optimistic.etherscan.io',
  arbitrum: 'https://arbiscan.io',
  base:     'https://basescan.org',
};
const QUOTER_ABI = [{
  name: 'quoteExactInputSingle', type: 'function', stateMutability: 'nonpayable',
  inputs: [{ type: 'tuple', components: [
    { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' },
    { name: 'amountIn', type: 'uint256' }, { name: 'fee', type: 'uint24' },
    { name: 'sqrtPriceLimitX96', type: 'uint160' },
  ]}],
  outputs: [
    { name: 'amountOut', type: 'uint256' },
    { name: 'sqrtPriceX96After', type: 'uint160' },
    { name: 'initializedTicksCrossed', type: 'uint32' },
    { name: 'gasEstimate', type: 'uint256' },
  ],
}];
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
  { name: 'balanceOf', type: 'function', stateMutability: 'view',
    inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'approve', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { name: 'allowance', type: 'function', stateMutability: 'view',
    inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
];

// ─── load operator key ───────────────────────────────────────
const PAXIOM_DIR = process.env.PAXIOM_DIR || join(homedir(), 'paxiom');
const DEFAULT_KEY_FILE = join(homedir(), '.paxiom', 'arb-runner', 'operator.key');
const LEGACY_KEY_FILE  = join(PAXIOM_DIR, '.arb-runner', 'operator.key');
const KEY_FILE = process.env.OPERATOR_KEY_FILE
  || (existsSync(DEFAULT_KEY_FILE) ? DEFAULT_KEY_FILE
       : existsSync(LEGACY_KEY_FILE) ? LEGACY_KEY_FILE : DEFAULT_KEY_FILE);
if (!existsSync(KEY_FILE)) fatal(`operator key not found at ${KEY_FILE} — start arb-runner once to generate it`);
const OPERATOR_KEY = readFileSync(KEY_FILE, 'utf8').trim();
const account = privateKeyToAccount(OPERATOR_KEY);

// ─── chain clients ───────────────────────────────────────────
const chainObj = (n) => ({ optimism, arbitrum, base })[n];
const publicC = (c) => createPublicClient({ chain: chainObj(c), transport: http(RPCS[c]) });
const walletC = (c) => createWalletClient({ account, chain: chainObj(c), transport: http(RPCS[c]) });

// Retry wrapper for read-only calls. Backs off on 429 / "over rate limit".
async function withRetry(label, fn, attempts = 5) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      const m = String(e?.message || '');
      const rateLimited = m.includes('over rate limit') || m.includes('429') || m.includes('Too Many Requests');
      if (!rateLimited) throw e;
      const wait = 1000 * Math.pow(2, i); // 1s, 2s, 4s, 8s, 16s
      log(`  [retry ${label}] rate-limited, waiting ${wait}ms (attempt ${i + 1}/${attempts})`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

// ─── flow ────────────────────────────────────────────────────
async function main() {
  log('═══ Paxiom test-trade — single shot, mainnet ═══');
  log(`buy:  ${BUY_CHAIN}    sell: ${SELL_CHAIN}    size: $${SIZE_USD}    slippage: ${SLIPPAGE_BPS} bps`);
  log(`operator: ${account.address}`);
  log('');

  const buy  = TOKENS[BUY_CHAIN];
  const sell = TOKENS[SELL_CHAIN];
  const buyP = publicC(BUY_CHAIN);
  const sellP = publicC(SELL_CHAIN);
  const buyW  = walletC(BUY_CHAIN);
  const sellW = walletC(SELL_CHAIN);

  const TRADE_USDC = BigInt(SIZE_USD) * 1_000000n;

  // 1. Balance pre-check (sequential to avoid hammering RPC)
  log('─ 1. Balance pre-check ─');
  const usdcBal = await withRetry('buy USDC', () => buyP.readContract({  address: buy.usdc,  abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }));
  const wethBal = await withRetry('sell WETH', () => sellP.readContract({ address: sell.weth, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }));
  const gasBuy  = await withRetry('buy gas',   () => buyP.getBalance({ address: account.address }));
  const gasSell = await withRetry('sell gas',  () => sellP.getBalance({ address: account.address }));
  log(`  ${BUY_CHAIN} USDC: ${(Number(usdcBal) / 1e6).toFixed(4)}    gas ETH: ${(Number(gasBuy) / 1e18).toFixed(6)}`);
  log(`  ${SELL_CHAIN} WETH: ${(Number(wethBal) / 1e18).toFixed(6)}    gas ETH: ${(Number(gasSell) / 1e18).toFixed(6)}`);
  if (usdcBal < TRADE_USDC) fatal(`insufficient USDC on ${BUY_CHAIN}`);
  // crude WETH bound (assume $1500/ETH as conservative ceiling = bigger required WETH)
  const minWeth = (TRADE_USDC * 10n ** 18n) / (1500n * 10n ** 6n);
  if (wethBal < minWeth) fatal(`insufficient WETH on ${SELL_CHAIN} (need ${(Number(minWeth) / 1e18).toFixed(6)})`);
  if (gasBuy < 10n ** 14n)  fatal(`gas ETH < 0.0001 on ${BUY_CHAIN}`);
  if (gasSell < 10n ** 14n) fatal(`gas ETH < 0.0001 on ${SELL_CHAIN}`);
  log('  OK.');
  log('');

  // 2. Quote both legs
  log('─ 2. Quote both legs at trade size ─');
  const buyQuote = await withRetry('buy quote', () => buyP.simulateContract({
    address: QUOTERS[BUY_CHAIN], abi: QUOTER_ABI, functionName: 'quoteExactInputSingle',
    args: [{ tokenIn: buy.usdc, tokenOut: buy.weth, amountIn: TRADE_USDC, fee: 500, sqrtPriceLimitX96: 0n }],
  }));
  const wethOut = buyQuote.result[0];
  const sellQuote = await withRetry('sell quote', () => sellP.simulateContract({
    address: QUOTERS[SELL_CHAIN], abi: QUOTER_ABI, functionName: 'quoteExactInputSingle',
    args: [{ tokenIn: sell.weth, tokenOut: sell.usdc, amountIn: wethOut, fee: 500, sqrtPriceLimitX96: 0n }],
  }));
  const usdcOut  = sellQuote.result[0];
  const usdcIn   = SIZE_USD;
  const usdcGross = Number(usdcOut) / 1e6 - usdcIn;
  const realSpreadPct = (usdcGross / usdcIn) * 100;
  log(`  buy  ${BUY_CHAIN}:  $${usdcIn} USDC → ${(Number(wethOut) / 1e18).toFixed(6)} WETH`);
  log(`  sell ${SELL_CHAIN}: ${(Number(wethOut) / 1e18).toFixed(6)} WETH → $${(Number(usdcOut) / 1e6).toFixed(6)} USDC`);
  log(`  gross delta: $${usdcGross.toFixed(6)} (${realSpreadPct.toFixed(4)}% round-trip)`);
  log(`  estimated gas total: ~$0.50 (L2)`);
  const estNet = usdcGross - 0.50;
  log(`  estimated net: $${estNet.toFixed(4)}`);
  if (estNet <= 0 && !FORCE_UNPROFITABLE) {
    fatal(`estimated net ≤ 0 — abort. re-run with --force to execute anyway (path test, will lose ~$${(-estNet).toFixed(2)})`);
  }
  log('');

  // 3. amountOutMinimum from quote + slippage
  const buyMinOut  = (wethOut * (SLIPPAGE_DENOM - SLIPPAGE_BPS)) / SLIPPAGE_DENOM;
  const sellMinOut = (usdcOut * (SLIPPAGE_DENOM - SLIPPAGE_BPS)) / SLIPPAGE_DENOM;
  log('─ 3. Slippage protection ─');
  log(`  buyMinOut  (WETH wei) = ${buyMinOut}`);
  log(`  sellMinOut (USDC base) = ${sellMinOut}  (≈ $${(Number(sellMinOut) / 1e6).toFixed(4)})`);
  log('');

  // 4. Plan summary
  log('─ 4. Broadcast plan ─');
  log(`  4a. approve ${buy.usdc} (${BUY_CHAIN} USDC) → router ${buy.router}  [MAX_UINT]`);
  log(`  4b. approve ${sell.weth} (${SELL_CHAIN} WETH) → router ${sell.router}  [MAX_UINT]`);
  log(`  4c. swap ${BUY_CHAIN}: USDC → WETH at fee 500, amountIn=${TRADE_USDC}, minOut=${buyMinOut}`);
  log(`  4d. swap ${SELL_CHAIN}: WETH → USDC at fee 500, amountIn=${wethOut}, minOut=${sellMinOut}`);
  log(`  Approvals fire in parallel; swaps fire in parallel after approvals confirm.`);
  log('');

  // 5. Confirm
  if (!NON_INTERACTIVE) {
    const yes = await prompt(`Type 'yes' to broadcast the 4 transactions above: `);
    if (yes.trim().toLowerCase() !== 'yes') fatal('aborted by user');
  } else {
    log('--yes flag set, proceeding.');
  }

  // 6. Approvals — check existing allowance, skip if already MAX
  log('');
  log('─ 6. Approvals (parallel) ─');
  const MAX_UINT = (1n << 256n) - 1n;
  const HALF_MAX = MAX_UINT / 2n;
  const buyAllow  = await withRetry('buy allowance',  () => buyP.readContract({  address: buy.usdc,  abi: ERC20_ABI, functionName: 'allowance', args: [account.address, buy.router] }));
  const sellAllow = await withRetry('sell allowance', () => sellP.readContract({ address: sell.weth, abi: ERC20_ABI, functionName: 'allowance', args: [account.address, sell.router] }));
  const tasks = [];
  if (buyAllow < HALF_MAX) {
    tasks.push((async () => {
      const h = await buyW.sendTransaction({
        to: buy.usdc, gas: 60000n,
        data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [buy.router, MAX_UINT] }),
      });
      log(`  buy approve  → ${EXPLORERS[BUY_CHAIN]}/tx/${h}`);
    })());
  } else {
    log(`  buy ${BUY_CHAIN} USDC already approved`);
  }
  if (sellAllow < HALF_MAX) {
    tasks.push((async () => {
      const h = await sellW.sendTransaction({
        to: sell.weth, gas: 60000n,
        data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [sell.router, MAX_UINT] }),
      });
      log(`  sell approve → ${EXPLORERS[SELL_CHAIN]}/tx/${h}`);
    })());
  } else {
    log(`  sell ${SELL_CHAIN} WETH already approved`);
  }
  // Wait for any approval txs we sent — re-fetch allowance until both are MAX.
  if (tasks.length) {
    await Promise.all(tasks);
    // Poll allowance for up to 30s
    const start = Date.now();
    while (Date.now() - start < 30000) {
      const a1 = await withRetry('poll buy allow',  () => buyP.readContract({  address: buy.usdc,  abi: ERC20_ABI, functionName: 'allowance', args: [account.address, buy.router] }));
      const a2 = await withRetry('poll sell allow', () => sellP.readContract({ address: sell.weth, abi: ERC20_ABI, functionName: 'allowance', args: [account.address, sell.router] }));
      if (a1 >= HALF_MAX && a2 >= HALF_MAX) { log('  allowances confirmed.'); break; }
      await sleep(2000);
    }
  }
  log('');

  // 7. Swaps in parallel
  log('─ 7. Swaps (parallel) ─');
  const [buyHash, sellHash] = await Promise.all([
    buyW.sendTransaction({
      to: buy.router, gas: 250000n,
      data: encodeFunctionData({ abi: SWAP_ABI, functionName: 'exactInputSingle', args: [{
        tokenIn: buy.usdc, tokenOut: buy.weth, fee: 500,
        recipient: account.address, amountIn: TRADE_USDC,
        amountOutMinimum: buyMinOut, sqrtPriceLimitX96: 0n,
      }] }),
    }),
    sellW.sendTransaction({
      to: sell.router, gas: 250000n,
      data: encodeFunctionData({ abi: SWAP_ABI, functionName: 'exactInputSingle', args: [{
        tokenIn: sell.weth, tokenOut: sell.usdc, fee: 500,
        recipient: account.address, amountIn: wethOut,
        amountOutMinimum: sellMinOut, sqrtPriceLimitX96: 0n,
      }] }),
    }),
  ]);
  log(`  buy  → ${EXPLORERS[BUY_CHAIN]}/tx/${buyHash}`);
  log(`  sell → ${EXPLORERS[SELL_CHAIN]}/tx/${sellHash}`);
  log('');

  // 8. Wait for receipts
  log('─ 8. Waiting for both receipts (≤60s) ─');
  const results = await Promise.allSettled([
    buyP.waitForTransactionReceipt({  hash: buyHash,  timeout: 60_000 }),
    sellP.waitForTransactionReceipt({ hash: sellHash, timeout: 60_000 }),
  ]);
  const buyResult  = results[0];
  const sellResult = results[1];
  const buyOk  = buyResult.status === 'fulfilled' && buyResult.value.status === 'success';
  const sellOk = sellResult.status === 'fulfilled' && sellResult.value.status === 'success';
  log(`  buy:  ${buyOk ? 'SUCCESS'  : (buyResult.status === 'fulfilled' ? 'REVERTED' : 'TIMEOUT/ERROR')} ${buyResult.value?.blockNumber ? `block ${buyResult.value.blockNumber}` : ''}`);
  log(`  sell: ${sellOk ? 'SUCCESS' : (sellResult.status === 'fulfilled' ? 'REVERTED' : 'TIMEOUT/ERROR')} ${sellResult.value?.blockNumber ? `block ${sellResult.value.blockNumber}` : ''}`);
  log('');

  // 9. Final balances + delta
  log('─ 9. Final balances ─');
  const usdcBal2     = await withRetry('final buy USDC',  () => buyP.readContract({  address: buy.usdc,  abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }));
  const wethBal2     = await withRetry('final sell WETH', () => sellP.readContract({ address: sell.weth, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }));
  const sellChainUsdc = await withRetry('final sell USDC', () => sellP.readContract({ address: sell.usdc, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }));
  log(`  ${BUY_CHAIN} USDC:  ${(Number(usdcBal)  / 1e6).toFixed(4)} → ${(Number(usdcBal2)  / 1e6).toFixed(4)}    Δ ${((Number(usdcBal2) - Number(usdcBal)) / 1e6).toFixed(4)}`);
  log(`  ${SELL_CHAIN} WETH: ${(Number(wethBal)  / 1e18).toFixed(6)} → ${(Number(wethBal2) / 1e18).toFixed(6)}    Δ ${((Number(wethBal2) - Number(wethBal)) / 1e18).toFixed(6)}`);
  log(`  ${SELL_CHAIN} USDC: → ${(Number(sellChainUsdc) / 1e6).toFixed(4)} (the trade output)`);
  log('');

  // 10. Append to execution.log so the rest of the platform sees it
  appendFileSync(join(PAXIOM_DIR, 'execution.log'), JSON.stringify({
    timestamp: new Date().toISOString(),
    source: 'TEST-TRADE',
    asset: 'ETH',
    spreadPct: realSpreadPct.toFixed(4),
    buyChain: BUY_CHAIN,
    sellChain: SELL_CHAIN,
    chainATxHash: buyHash,
    chainBTxHash: sellHash,
    timingGapMs: 0,
    status: 'broadcast_success',
    estimatedProfit: usdcGross - 0.50,
  }) + '\n');

  if (buyOk && sellOk) {
    log('✅ Both legs confirmed. Path verified end-to-end.');
    process.exit(0);
  }
  if (buyOk && !sellOk) {
    log('⚠️ HALF-FILL: buy succeeded, sell did not. Check the unwind monitor — recoverable via local swap.');
    process.exit(2);
  }
  if (!buyOk && sellOk) {
    log('⚠️ HALF-FILL: sell succeeded, buy did not. WETH consumed on sell-chain; recoverable via local swap.');
    process.exit(2);
  }
  log('❌ Both reverted/timed out. Check tx links above.');
  process.exit(3);
}

// ─── helpers ─────────────────────────────────────────────────
function log(s) { console.log(s); }
function fatal(s) { console.error(`FATAL: ${s}`); process.exit(1); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function prompt(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (ans) => { rl.close(); resolve(ans); });
  });
}

main().catch((e) => fatal(e.stack || e.message));
