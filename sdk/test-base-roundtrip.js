// Same-chain Base path test using native ETH.
//
// Flow on Base mainnet, all signed by the operator wallet:
//   1. Wrap N ETH → WETH (WETH.deposit)
//   2. Approve Uniswap V3 router for WETH (MAX_UINT, idempotent)
//   3. Swap WETH → USDC at fee 500
//   4. Approve router for USDC
//   5. Swap USDC → WETH at fee 500
//   6. Unwrap WETH → ETH (WETH.withdraw)
//
// Cost: ~$0.30-$0.60 in gas + ~$0.02 in pool fees on Base.
// Validates: operator key, viem chain config, ERC20 approvals, Uniswap V3
// router calldata, slippage protection, receipt handling.
// Does NOT validate: cross-chain coordination, half-fills, scanner integration.
//
// Usage:
//   # Send some ETH from MetaMask to the operator address on Base first.
//   node sdk/test-base-roundtrip.js --eth 0.012        # ~$30 round-trip
//   node sdk/test-base-roundtrip.js --eth 0.005 --yes  # smaller, no prompt

import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createInterface } from 'readline';
import { createPublicClient, createWalletClient, http, encodeFunctionData, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

// ─── args ─────────────────────────────────────────────────────
const args = process.argv.slice(2);
const arg = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const flag = (name) => args.includes(`--${name}`);
const ETH_AMOUNT = arg('eth', '0.005');
const SLIPPAGE_BPS = BigInt(arg('slippage', '50'));
const SLIPPAGE_DENOM = 10000n;
const NON_INTERACTIVE = flag('yes');
const MAX_ETH = 0.05;
if (!Number.isFinite(Number(ETH_AMOUNT)) || Number(ETH_AMOUNT) <= 0) fatal('--eth must be positive');
if (Number(ETH_AMOUNT) > MAX_ETH) fatal(`--eth ${ETH_AMOUNT} exceeds hard cap ${MAX_ETH}`);
const VALUE_WEI = parseEther(ETH_AMOUNT);

// ─── config (Base mainnet) ───────────────────────────────────
const RPC    = process.env.RPC_BASE || 'https://mainnet.base.org';
const WETH   = '0x4200000000000000000000000000000000000006';
const USDC   = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ROUTER = '0x2626664c2603336E57B271c5C0b26F421741e481';
const FEE_TIER = 500;
const EXPLORER = 'https://basescan.org';

const WETH_ABI = [
  { name: 'deposit',  type: 'function', stateMutability: 'payable',    inputs: [], outputs: [] },
  { name: 'withdraw', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'uint256' }], outputs: [] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view',
    inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
];
const ERC20_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view',
    inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'approve', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { name: 'allowance', type: 'function', stateMutability: 'view',
    inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
];
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

// ─── operator key + clients ──────────────────────────────────
const PAXIOM_DIR = process.env.PAXIOM_DIR || join(homedir(), 'paxiom');
const DEFAULT_KEY_FILE = join(homedir(), '.paxiom', 'arb-runner', 'operator.key');
const LEGACY_KEY_FILE  = join(PAXIOM_DIR, '.arb-runner', 'operator.key');
const KEY_FILE = process.env.OPERATOR_KEY_FILE
  || (existsSync(DEFAULT_KEY_FILE) ? DEFAULT_KEY_FILE
       : existsSync(LEGACY_KEY_FILE) ? LEGACY_KEY_FILE : DEFAULT_KEY_FILE);
if (!existsSync(KEY_FILE)) fatal(`operator key not found at ${KEY_FILE} — start arb-runner once to generate it`);
const account = privateKeyToAccount(readFileSync(KEY_FILE, 'utf8').trim());
const publicC = createPublicClient({ chain: base, transport: http(RPC) });
const walletC = createWalletClient({ account, chain: base, transport: http(RPC) });

async function withRetry(label, fn, attempts = 5) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      const m = String(e?.message || '');
      if (!(m.includes('over rate limit') || m.includes('429') || m.includes('Too Many Requests'))) throw e;
      const wait = 1000 * Math.pow(2, i);
      log(`  [retry ${label}] 429, waiting ${wait}ms (${i + 1}/${attempts})`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

async function send(label, tx) {
  const hash = await walletC.sendTransaction(tx);
  log(`  ${label} → ${EXPLORER}/tx/${hash}`);
  const receipt = await publicC.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (receipt.status !== 'success') fatal(`${label} reverted (block ${receipt.blockNumber})`);
  log(`  ${label} confirmed (block ${receipt.blockNumber})`);
  return receipt;
}

async function main() {
  log('═══ Paxiom test-base-roundtrip — single chain (Base) ═══');
  log(`operator: ${account.address}`);
  log(`amount:   ${ETH_AMOUNT} ETH (${VALUE_WEI} wei)`);
  log(`slippage: ${SLIPPAGE_BPS} bps`);
  log('');

  // 0. Pre-state
  log('─ 0. Pre-state ─');
  const ethBefore  = await withRetry('eth bal',  () => publicC.getBalance({ address: account.address }));
  const wethBefore = await withRetry('weth bal', () => publicC.readContract({ address: WETH, abi: WETH_ABI, functionName: 'balanceOf', args: [account.address] }));
  log(`  ETH:  ${(Number(ethBefore)  / 1e18).toFixed(8)}`);
  log(`  WETH: ${(Number(wethBefore) / 1e18).toFixed(8)}`);
  if (ethBefore < VALUE_WEI + parseEther('0.001')) {
    fatal(`insufficient ETH (need ${ETH_AMOUNT} + 0.001 gas buffer; have ${(Number(ethBefore)/1e18).toFixed(6)})`);
  }
  log('');

  // Confirm
  if (!NON_INTERACTIVE) {
    const yes = await prompt(`Type 'yes' to broadcast 6 transactions (wrap, approve, swap, approve, swap, unwrap): `);
    if (yes.trim().toLowerCase() !== 'yes') fatal('aborted by user');
  }

  // 1. Wrap ETH → WETH
  log('');
  log('─ 1. Wrap ETH → WETH ─');
  await send('wrap', {
    to: WETH, value: VALUE_WEI, gas: 60000n,
    data: encodeFunctionData({ abi: WETH_ABI, functionName: 'deposit', args: [] }),
  });

  // 2. Approve router for WETH (idempotent)
  log('─ 2. Approve router for WETH ─');
  const MAX_UINT = (1n << 256n) - 1n;
  const wethAllow = await withRetry('weth allow', () => publicC.readContract({ address: WETH, abi: ERC20_ABI, functionName: 'allowance', args: [account.address, ROUTER] }));
  if (wethAllow < MAX_UINT / 2n) {
    await send('approve WETH', {
      to: WETH, gas: 60000n,
      data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [ROUTER, MAX_UINT] }),
    });
  } else {
    log('  WETH already approved');
  }

  // 3. Quote + swap WETH → USDC
  log('─ 3. Swap WETH → USDC ─');
  const quoter = '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a';
  const quoterAbi = [{
    name: 'quoteExactInputSingle', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ type: 'tuple', components: [
      { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' },
      { name: 'amountIn', type: 'uint256' }, { name: 'fee', type: 'uint24' },
      { name: 'sqrtPriceLimitX96', type: 'uint160' },
    ]}],
    outputs: [{ type: 'uint256' }, { type: 'uint160' }, { type: 'uint32' }, { type: 'uint256' }],
  }];
  const q1 = await withRetry('quote WETH→USDC', () => publicC.simulateContract({
    address: quoter, abi: quoterAbi, functionName: 'quoteExactInputSingle',
    args: [{ tokenIn: WETH, tokenOut: USDC, amountIn: VALUE_WEI, fee: FEE_TIER, sqrtPriceLimitX96: 0n }],
  }));
  const usdcOut = q1.result[0];
  const usdcMin = (usdcOut * (SLIPPAGE_DENOM - SLIPPAGE_BPS)) / SLIPPAGE_DENOM;
  log(`  quote: ${ETH_AMOUNT} WETH → ${(Number(usdcOut) / 1e6).toFixed(4)} USDC  (min ${(Number(usdcMin) / 1e6).toFixed(4)})`);
  await send('swap WETH→USDC', {
    to: ROUTER, gas: 250000n,
    data: encodeFunctionData({ abi: SWAP_ABI, functionName: 'exactInputSingle', args: [{
      tokenIn: WETH, tokenOut: USDC, fee: FEE_TIER,
      recipient: account.address, amountIn: VALUE_WEI,
      amountOutMinimum: usdcMin, sqrtPriceLimitX96: 0n,
    }] }),
  });

  // 4. Approve router for USDC
  log('─ 4. Approve router for USDC ─');
  const usdcBal = await withRetry('usdc bal', () => publicC.readContract({ address: USDC, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }));
  log(`  current USDC: ${(Number(usdcBal) / 1e6).toFixed(4)}`);
  const usdcAllow = await withRetry('usdc allow', () => publicC.readContract({ address: USDC, abi: ERC20_ABI, functionName: 'allowance', args: [account.address, ROUTER] }));
  if (usdcAllow < MAX_UINT / 2n) {
    await send('approve USDC', {
      to: USDC, gas: 60000n,
      data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [ROUTER, MAX_UINT] }),
    });
  } else {
    log('  USDC already approved');
  }

  // 5. Quote + swap USDC → WETH
  log('─ 5. Swap USDC → WETH ─');
  const q2 = await withRetry('quote USDC→WETH', () => publicC.simulateContract({
    address: quoter, abi: quoterAbi, functionName: 'quoteExactInputSingle',
    args: [{ tokenIn: USDC, tokenOut: WETH, amountIn: usdcBal, fee: FEE_TIER, sqrtPriceLimitX96: 0n }],
  }));
  const wethOut = q2.result[0];
  const wethMin = (wethOut * (SLIPPAGE_DENOM - SLIPPAGE_BPS)) / SLIPPAGE_DENOM;
  log(`  quote: ${(Number(usdcBal) / 1e6).toFixed(4)} USDC → ${(Number(wethOut) / 1e18).toFixed(8)} WETH  (min ${(Number(wethMin) / 1e18).toFixed(8)})`);
  await send('swap USDC→WETH', {
    to: ROUTER, gas: 250000n,
    data: encodeFunctionData({ abi: SWAP_ABI, functionName: 'exactInputSingle', args: [{
      tokenIn: USDC, tokenOut: WETH, fee: FEE_TIER,
      recipient: account.address, amountIn: usdcBal,
      amountOutMinimum: wethMin, sqrtPriceLimitX96: 0n,
    }] }),
  });

  // 6. Unwrap WETH → ETH
  log('─ 6. Unwrap WETH → ETH ─');
  const wethFinal = await withRetry('weth final', () => publicC.readContract({ address: WETH, abi: WETH_ABI, functionName: 'balanceOf', args: [account.address] }));
  log(`  unwrap amount: ${(Number(wethFinal) / 1e18).toFixed(8)} WETH`);
  await send('unwrap', {
    to: WETH, gas: 60000n,
    data: encodeFunctionData({ abi: WETH_ABI, functionName: 'withdraw', args: [wethFinal] }),
  });

  // 7. Report
  log('');
  log('─ 7. Summary ─');
  const ethAfter  = await withRetry('eth final',  () => publicC.getBalance({ address: account.address }));
  const wethAfter = await withRetry('weth final2', () => publicC.readContract({ address: WETH, abi: WETH_ABI, functionName: 'balanceOf', args: [account.address] }));
  const usdcAfter = await withRetry('usdc final', () => publicC.readContract({ address: USDC, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }));
  const ethDelta = Number(ethAfter - ethBefore) / 1e18;
  log(`  ETH:  ${(Number(ethBefore) / 1e18).toFixed(8)} → ${(Number(ethAfter) / 1e18).toFixed(8)}  (Δ ${ethDelta.toFixed(8)})`);
  log(`  WETH: ${(Number(wethBefore) / 1e18).toFixed(8)} → ${(Number(wethAfter) / 1e18).toFixed(8)}`);
  log(`  USDC dust: ${(Number(usdcAfter) / 1e6).toFixed(6)}`);
  log(`  Net ETH cost: ~${(-ethDelta * 2400).toFixed(2)} USD (gas + pool fees, estimated at $2400/ETH)`);
  log('');
  log('✅ Path validated end-to-end on Base mainnet.');
  log('');
  log('To recover the operator funds, send them back to your MetaMask wallet:');
  log(`  curl -X POST -H 'Content-Type: application/json' \\`);
  log(`    -d '{"chain":"base","asset":"weth","amount":${(Number(wethAfter) / 1e18).toFixed(8)},"to":"<YOUR_METAMASK_ADDRESS>"}' \\`);
  log(`    http://127.0.0.1:3000/api/arb/withdraw`);
  log(`  (or use the UI inventory panel "→ MM WETH" button)`);
  log(`  Native ETH withdrawal isn't wired yet — see followups.`);
}

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
