// Arb Runner — autonomous execution service.
//
// Manages an operator wallet (separate from the user's MetaMask), spawns
// sdk/live-executor.js as a managed child, and exposes engine controls,
// per-chain balances, and live performance metrics over HTTP.
//
// MetaMask is used by the UI for funding the operator wallet and for the
// emergency-close sweep — never per-trade. Trades sign with the operator
// key inside the spawned executor.
//
// The operator key is generated on first run, stored at $PAXIOM_DIR/.arb-runner/
// operator.key with mode 0600, and never returned over HTTP.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, statSync,
  appendFileSync, unlinkSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, createWalletClient, http, encodeFunctionData } from 'viem';
import { optimism, arbitrum, base } from 'viem/chains';
import { sendJson, methodNotAllowed, notFound, readJsonBody } from '../shared/http.mjs';

const PORT = Number(process.env.ARB_RUNNER_PORT || 8086);
const HOST = process.env.ARB_RUNNER_HOST || '127.0.0.1';
const PAXIOM_DIR = process.env.PAXIOM_DIR || `${process.env.HOME}/paxiom`;
// Operator key lives OUTSIDE the repo tree by default — repo is potentially
// committed/synced/cloned and key material must not leak. Override via
// OPERATOR_KEY_FILE env var (e.g. mount a hardware-backed location).
const KEY_DIR    = process.env.OPERATOR_KEY_DIR || `${process.env.HOME}/.paxiom/arb-runner`;
const KEY_FILE   = process.env.OPERATOR_KEY_FILE || join(KEY_DIR, 'operator.key');
// Legacy location used in earlier sessions — surfaced as a migration warning.
const LEGACY_KEY_FILE = join(PAXIOM_DIR, '.arb-runner', 'operator.key');
const EXEC_LOG   = process.env.EXEC_LOG   || join(PAXIOM_DIR, 'execution.log');
const UNWIND_LOG = process.env.UNWIND_LOG || join(PAXIOM_DIR, 'unwind.log');
const KILL_FILE  = process.env.KILL_FILE  || '/tmp/paxiom-kill';
const here = dirname(fileURLToPath(import.meta.url));
const EXECUTOR_SCRIPT = resolve(here, '../../sdk/live-executor.js');
const TEST_TRADE_SCRIPT = resolve(here, '../../sdk/test-trade.js');

// ─── operator wallet ──────────────────────────────────────────
function loadOrCreateOperatorKey() {
  if (process.env.OPERATOR_PRIVATE_KEY) {
    return process.env.OPERATOR_PRIVATE_KEY.startsWith('0x')
      ? process.env.OPERATOR_PRIVATE_KEY
      : `0x${process.env.OPERATOR_PRIVATE_KEY}`;
  }
  if (!existsSync(KEY_DIR)) mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });
  if (existsSync(KEY_FILE)) return readFileSync(KEY_FILE, 'utf8').trim();
  // Migration: if a key exists at the legacy location and not at the new one,
  // load it from there but log a strong warning. We do not auto-move it — that's
  // the operator's call (and they should back it up first).
  if (KEY_FILE !== LEGACY_KEY_FILE && existsSync(LEGACY_KEY_FILE)) {
    console.warn(`[arb-runner] WARNING: operator key found at legacy in-repo location ${LEGACY_KEY_FILE}`);
    console.warn(`[arb-runner] Move it OUT of the repo to ${KEY_FILE}:`);
    console.warn(`[arb-runner]   mkdir -p $(dirname ${KEY_FILE}) && mv ${LEGACY_KEY_FILE} ${KEY_FILE} && chmod 600 ${KEY_FILE}`);
    console.warn(`[arb-runner] Loading from legacy location for now. BACK UP THE KEY before moving.`);
    return readFileSync(LEGACY_KEY_FILE, 'utf8').trim();
  }
  const fresh = generatePrivateKey();
  writeFileSync(KEY_FILE, fresh + '\n', { mode: 0o600 });
  try { chmodSync(KEY_FILE, 0o600); } catch {}
  console.log(`[arb-runner] generated new operator key at ${KEY_FILE} — BACK IT UP`);
  return fresh;
}

const OPERATOR_KEY = loadOrCreateOperatorKey();
const operatorAccount = privateKeyToAccount(OPERATOR_KEY);
console.log(`[arb-runner] operator address: ${operatorAccount.address}`);

// ─── chain clients (mainnet) ──────────────────────────────────
const RPCS = {
  optimism: process.env.RPC_OPTIMISM || 'https://mainnet.optimism.io',
  arbitrum: process.env.RPC_ARBITRUM || 'https://arb1.arbitrum.io/rpc',
  base:     process.env.RPC_BASE     || 'https://mainnet.base.org',
};
const TOKENS = {
  optimism: { usdc: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', weth: '0x4200000000000000000000000000000000000006' },
  arbitrum: { usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', weth: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1' },
  base:     { usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', weth: '0x4200000000000000000000000000000000000006' },
};
const ERC20_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view',
    inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'transfer', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
];
const chainObj = (n) => ({ optimism, arbitrum, base })[n];
const publicClients = Object.fromEntries(
  Object.keys(RPCS).map((c) => [c, createPublicClient({ chain: chainObj(c), transport: http(RPCS[c]) })])
);
const walletClients = Object.fromEntries(
  Object.keys(RPCS).map((c) => [c, createWalletClient({ account: operatorAccount, chain: chainObj(c), transport: http(RPCS[c]) })])
);
const LIFI_CHAIN_IDS = { optimism: 10, base: 8453, arbitrum: 42161 };
const LIFI_TOKENS = {
  optimism: { eth: 'ETH', usdc: 'USDC', weth: TOKENS.optimism.weth },
  base: { eth: 'ETH', usdc: 'USDC', weth: TOKENS.base.weth },
  arbitrum: { eth: 'ETH', usdc: 'USDC', weth: TOKENS.arbitrum.weth },
};

function isAddress(s) {
  return typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s);
}

function tokenDecimals(asset) {
  return asset === 'usdc' ? 6 : 18;
}

function parseAmount(asset, human) {
  const n = Number(human);
  if (!Number.isFinite(n) || n <= 0) throw new Error('amount must be positive');
  const dec = tokenDecimals(asset);
  // viem expects bigint base units; multiply with rounding to avoid float drift.
  const factor = 10n ** BigInt(dec);
  const intPart  = BigInt(Math.floor(n));
  const fracPart = BigInt(Math.round((n - Math.floor(n)) * Number(factor)));
  return intPart * factor + fracPart;
}

export function buildBalancePlan({
  balances = {},
  tradeSizeUsd = 500,
  buyChain = 'optimism',
  sellChain = 'base',
  strategy = 'route',
  bufferPct = 10,
  gasEth = 0.001,
} = {}) {
  const chains = Object.keys(TOKENS);
  if (!chains.includes(buyChain)) throw new Error(`unknown buyChain ${buyChain}`);
  if (!chains.includes(sellChain)) throw new Error(`unknown sellChain ${sellChain}`);
  if (buyChain === sellChain) throw new Error('buyChain and sellChain must differ');
  if (!Number.isFinite(Number(tradeSizeUsd)) || Number(tradeSizeUsd) <= 0) throw new Error('tradeSizeUsd must be positive');
  if (!Number.isFinite(Number(bufferPct)) || Number(bufferPct) < 0) throw new Error('bufferPct must be non-negative');
  if (!Number.isFinite(Number(gasEth)) || Number(gasEth) < 0) throw new Error('gasEth must be non-negative');
  const mode = strategy === 'pair' ? 'pair' : 'route';
  const buffer = 1 + Number(bufferPct) / 100;
  const usdcTarget = Number(tradeSizeUsd) * buffer;
  const wethTarget = (Number(tradeSizeUsd) / 2000) * buffer;
  const targets = Object.fromEntries(chains.map((chain) => [chain, { usdc: 0, weth: 0, native: 0 }]));

  if (mode === 'pair') {
    for (const chain of [buyChain, sellChain]) {
      targets[chain].usdc = usdcTarget;
      targets[chain].weth = wethTarget;
      targets[chain].native = Number(gasEth);
    }
  } else {
    targets[buyChain].usdc = usdcTarget;
    targets[buyChain].native = Number(gasEth);
    targets[sellChain].weth = wethTarget;
    targets[sellChain].native = Number(gasEth);
  }

  const perChain = {};
  const actions = [];
  for (const chain of chains) {
    const current = balances[chain]?.ok ? balances[chain] : { usdc: 0, weth: 0, native: 0 };
    const target = targets[chain];
    const nativeReserve = target.native;
    const rawWethDeficit = Math.max(0, target.weth - Number(current.weth || 0));
    const nativeAvailableToWrap = Math.max(0, Number(current.native || 0) - nativeReserve);
    const wethCoveredByNative = Math.min(rawWethDeficit, nativeAvailableToWrap);
    const remainingWethDeficit = Math.max(0, rawWethDeficit - wethCoveredByNative);
    const deficits = {
      usdc: Math.max(0, target.usdc - Number(current.usdc || 0)),
      weth: 0,
      eth: Math.max(0, nativeReserve - Number(current.native || 0)) + remainingWethDeficit,
    };
    perChain[chain] = { target, current, deficits, ok: Object.values(deficits).every((v) => v <= 0.0000001) };
    for (const [asset, amount] of Object.entries(deficits)) {
      if (amount > 0) actions.push({
        chain,
        asset,
        amount,
        rounded: asset === 'usdc' ? roundUp(amount, 2) : roundUp(amount, 6),
      });
    }
  }

  return {
    ok: actions.length === 0,
    strategy: mode,
    buyChain,
    sellChain,
    tradeSizeUsd: Number(tradeSizeUsd),
    bufferPct: Number(bufferPct),
    gasEth: Number(gasEth),
    assumptions: {
      wethUsd: 2000,
      route: mode === 'route'
        ? 'funds only the selected buy/sell direction'
        : 'funds both chains with USDC and WETH so either direction can fire',
      wethFunding: 'WETH deficits are covered by existing or newly funded native ETH; the dust test wraps ETH to WETH as needed.',
    },
    perChain,
    actions,
  };
}

function roundUp(amount, decimals) {
  const factor = 10 ** decimals;
  return Math.ceil((Number(amount) - Number.EPSILON) * factor) / factor;
}

async function sendErc20(chain, asset, to, amount) {
  if (!RPCS[chain]) throw new Error(`unknown chain ${chain}`);
  if (asset !== 'usdc' && asset !== 'weth') throw new Error('asset must be usdc, weth, or eth');
  if (!isAddress(to)) throw new Error('to must be a 20-byte hex address');
  const tokenAddr = TOKENS[chain][asset];
  const data = encodeFunctionData({
    abi: ERC20_ABI, functionName: 'transfer', args: [to, amount],
  });
  const hash = await walletClients[chain].sendTransaction({
    to: tokenAddr, data, gas: 80_000n,
  });
  return { hash, chain, asset, to, amount: amount.toString() };
}

// ─── Base-only round-trip orchestrator (path test) ────────────
const ROUTERS = {
  optimism: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
  arbitrum: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
  base:     '0x2626664c2603336E57B271c5C0b26F421741e481',
};
const QUOTERS_PUB = {
  optimism: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  arbitrum: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  base:     '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
};
const WETH_ABI = [
  { name: 'deposit',  type: 'function', stateMutability: 'payable',    inputs: [], outputs: [] },
  { name: 'withdraw', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'uint256' }], outputs: [] },
];
const QUOTER_ABI = [{
  name: 'quoteExactInputSingle', type: 'function', stateMutability: 'nonpayable',
  inputs: [{ type: 'tuple', components: [
    { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' },
    { name: 'amountIn', type: 'uint256' }, { name: 'fee', type: 'uint24' },
    { name: 'sqrtPriceLimitX96', type: 'uint160' },
  ]}],
  outputs: [{ type: 'uint256' }, { type: 'uint160' }, { type: 'uint32' }, { type: 'uint256' }],
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
const ERC20_FULL = [
  ...ERC20_ABI,
  { name: 'approve', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { name: 'allowance', type: 'function', stateMutability: 'view',
    inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
];

let roundTripState = { active: false, steps: [], startedAt: null, finishedAt: null, error: null, summary: null };
let crossChainDustState = {
  active: false,
  startedAt: null,
  finishedAt: null,
  exitCode: null,
  error: null,
  command: null,
  output: '',
};

function pushStep(name) {
  const s = { name, status: 'pending', startedAt: new Date().toISOString() };
  roundTripState.steps.push(s);
  return s;
}
function completeStep(s, extra = {}) { s.status = 'success'; s.finishedAt = new Date().toISOString(); Object.assign(s, extra); }
function failStep(s, err) { s.status = 'failed'; s.error = err.message?.slice(0, 200) || String(err); s.finishedAt = new Date().toISOString(); }

async function runRoundTripBase({ ethAmount, slippageBps = 50 }) {
  if (roundTripState.active) throw new Error('round-trip already in progress');
  if (!Number.isFinite(ethAmount) || ethAmount <= 0 || ethAmount > 0.05) {
    throw new Error('ethAmount must be > 0 and ≤ 0.05');
  }
  roundTripState = { active: true, steps: [], startedAt: new Date().toISOString(), finishedAt: null, error: null, summary: null };

  const chain = 'base';
  const cfg = TOKENS[chain];
  const router = ROUTERS[chain];
  const quoter = QUOTERS_PUB[chain];
  const FEE = 500;
  const MAX_UINT = (1n << 256n) - 1n;
  const SLIPPAGE_DENOM = 10000n;
  const slip = BigInt(slippageBps);
  const valueWei = BigInt(Math.round(ethAmount * 1e18));
  const pub = publicClients[chain];
  const wallet = walletClients[chain];

  const ethBefore  = await withRpcRetry('eth bal',  () => pub.getBalance({ address: operatorAccount.address }));
  const wethBefore = await withRpcRetry('weth bal', () => pub.readContract({ address: cfg.weth, abi: ERC20_FULL, functionName: 'balanceOf', args: [operatorAccount.address] }));
  // Skip-wrap with float-tolerance: any WETH ≥ 99% of valueWei counts as
  // sufficient (handles fixed-point display precision from prior wraps). When
  // skipping wrap with partial coverage, swap the actual WETH balance — not
  // the requested amount — to avoid a balance-shortfall revert on the swap.
  const ninetyNinePct = (valueWei * 99n) / 100n;
  const willSkipWrap = wethBefore >= ninetyNinePct;
  const swapWei = willSkipWrap && wethBefore < valueWei ? wethBefore : valueWei;
  const GAS_BUFFER_WEI  = 5n * 10n ** 13n;
  const FIVE_TX_BUFFER  = 5n * GAS_BUFFER_WEI;
  const ethNeeded = willSkipWrap ? FIVE_TX_BUFFER : (valueWei + FIVE_TX_BUFFER + 10n ** 14n);
  if (ethBefore < ethNeeded) {
    roundTripState.active = false;
    roundTripState.finishedAt = new Date().toISOString();
    roundTripState.error = `insufficient ETH: have ${Number(ethBefore) / 1e18}, need ${Number(ethNeeded) / 1e18}${willSkipWrap ? ' (wrap will be skipped — existing WETH sufficient)' : ''}`;
    throw new Error(roundTripState.error);
  }

  try {
    // 1. Wrap ETH → WETH (skip if existing WETH already covers valueWei)
    let s = pushStep('wrap');
    if (willSkipWrap) {
      s.skipped = true;
      s.note = `already have ${(Number(wethBefore) / 1e18).toFixed(8)} WETH — wrap skipped`;
    } else {
      const wrapHash = await wallet.sendTransaction({
        to: cfg.weth, value: valueWei, gas: 60000n,
        data: encodeFunctionData({ abi: WETH_ABI, functionName: 'deposit', args: [] }),
      });
      s.txHash = wrapHash;
      await pub.waitForTransactionReceipt({ hash: wrapHash, timeout: 60000 });
    }
    completeStep(s);

    // 2. Approve WETH → router (skip if already approved)
    s = pushStep('approve_weth');
    const wethAllow = await withRpcRetry('weth allow', () => pub.readContract({ address: cfg.weth, abi: ERC20_FULL, functionName: 'allowance', args: [operatorAccount.address, router] }));
    if (wethAllow < MAX_UINT / 2n) {
      const h = await wallet.sendTransaction({
        to: cfg.weth, gas: 60000n,
        data: encodeFunctionData({ abi: ERC20_FULL, functionName: 'approve', args: [router, MAX_UINT] }),
      });
      s.txHash = h;
      await pub.waitForTransactionReceipt({ hash: h, timeout: 60000 });
    } else {
      s.skipped = true;
    }
    completeStep(s);

    // 3. Quote + swap WETH → USDC (use swapWei — handles partial-WETH skip-wrap case)
    s = pushStep('swap_weth_to_usdc');
    const q1 = await withRpcRetry('quote weth->usdc', () => pub.simulateContract({
      address: quoter, abi: QUOTER_ABI, functionName: 'quoteExactInputSingle',
      args: [{ tokenIn: cfg.weth, tokenOut: cfg.usdc, amountIn: swapWei, fee: FEE, sqrtPriceLimitX96: 0n }],
    }));
    const usdcOut = q1.result[0];
    const usdcMin = (usdcOut * (SLIPPAGE_DENOM - slip)) / SLIPPAGE_DENOM;
    s.quote = { inWeth: Number(swapWei) / 1e18, outUsdc: Number(usdcOut) / 1e6, minUsdc: Number(usdcMin) / 1e6 };
    const h3 = await wallet.sendTransaction({
      to: router, gas: 250000n,
      data: encodeFunctionData({ abi: SWAP_ABI, functionName: 'exactInputSingle', args: [{
        tokenIn: cfg.weth, tokenOut: cfg.usdc, fee: FEE,
        recipient: operatorAccount.address, amountIn: swapWei,
        amountOutMinimum: usdcMin, sqrtPriceLimitX96: 0n,
      }] }),
    });
    s.txHash = h3;
    await pub.waitForTransactionReceipt({ hash: h3, timeout: 60000 });
    completeStep(s);

    // 4. Approve USDC → router
    s = pushStep('approve_usdc');
    const usdcAllow = await withRpcRetry('usdc allow', () => pub.readContract({ address: cfg.usdc, abi: ERC20_FULL, functionName: 'allowance', args: [operatorAccount.address, router] }));
    const usdcBal = await withRpcRetry('usdc bal', () => pub.readContract({ address: cfg.usdc, abi: ERC20_FULL, functionName: 'balanceOf', args: [operatorAccount.address] }));
    if (usdcAllow < MAX_UINT / 2n) {
      const h = await wallet.sendTransaction({
        to: cfg.usdc, gas: 60000n,
        data: encodeFunctionData({ abi: ERC20_FULL, functionName: 'approve', args: [router, MAX_UINT] }),
      });
      s.txHash = h;
      await pub.waitForTransactionReceipt({ hash: h, timeout: 60000 });
    } else {
      s.skipped = true;
    }
    completeStep(s);

    // 5. Quote + swap USDC → WETH
    s = pushStep('swap_usdc_to_weth');
    const q2 = await withRpcRetry('quote usdc->weth', () => pub.simulateContract({
      address: quoter, abi: QUOTER_ABI, functionName: 'quoteExactInputSingle',
      args: [{ tokenIn: cfg.usdc, tokenOut: cfg.weth, amountIn: usdcBal, fee: FEE, sqrtPriceLimitX96: 0n }],
    }));
    const wethOut = q2.result[0];
    const wethMin = (wethOut * (SLIPPAGE_DENOM - slip)) / SLIPPAGE_DENOM;
    s.quote = { inUsdc: Number(usdcBal) / 1e6, outWeth: Number(wethOut) / 1e18, minWeth: Number(wethMin) / 1e18 };
    const h5 = await wallet.sendTransaction({
      to: router, gas: 250000n,
      data: encodeFunctionData({ abi: SWAP_ABI, functionName: 'exactInputSingle', args: [{
        tokenIn: cfg.usdc, tokenOut: cfg.weth, fee: FEE,
        recipient: operatorAccount.address, amountIn: usdcBal,
        amountOutMinimum: wethMin, sqrtPriceLimitX96: 0n,
      }] }),
    });
    s.txHash = h5;
    await pub.waitForTransactionReceipt({ hash: h5, timeout: 60000 });
    completeStep(s);

    // 6. Unwrap WETH → ETH
    s = pushStep('unwrap');
    // WETH9 is an ERC20, so use ERC20_FULL for the balanceOf read (WETH_ABI here only
    // declares deposit/withdraw, not balanceOf — encoding fails otherwise).
    const wethFinal = await withRpcRetry('weth final', () => pub.readContract({ address: cfg.weth, abi: ERC20_FULL, functionName: 'balanceOf', args: [operatorAccount.address] }));
    const h6 = await wallet.sendTransaction({
      to: cfg.weth, gas: 60000n,
      data: encodeFunctionData({ abi: WETH_ABI, functionName: 'withdraw', args: [wethFinal] }),
    });
    s.txHash = h6;
    await pub.waitForTransactionReceipt({ hash: h6, timeout: 60000 });
    completeStep(s);

    // Summary
    const ethAfter = await withRpcRetry('eth after', () => pub.getBalance({ address: operatorAccount.address }));
    roundTripState.summary = {
      ethBefore: Number(ethBefore) / 1e18,
      ethAfter:  Number(ethAfter)  / 1e18,
      ethDelta:  Number(ethAfter - ethBefore) / 1e18,
    };
  } catch (e) {
    const last = roundTripState.steps[roundTripState.steps.length - 1];
    if (last && last.status === 'pending') failStep(last, e);
    roundTripState.error = e.message?.slice(0, 200) || String(e);
  } finally {
    roundTripState.active = false;
    roundTripState.finishedAt = new Date().toISOString();
  }
}

function startCrossChainDustTest({
  buyChain = 'optimism',
  sellChain = 'base',
  sizeUsd = 1,
  slippageBps = 50,
} = {}) {
  if (crossChainDustState.active) throw new Error('cross-chain dust test already in progress');
  if (!TOKENS[buyChain]) throw new Error(`unknown buyChain ${buyChain}`);
  if (!TOKENS[sellChain]) throw new Error(`unknown sellChain ${sellChain}`);
  if (buyChain === sellChain) throw new Error('buyChain and sellChain must differ');
  const size = Number(sizeUsd);
  if (!Number.isFinite(size) || size <= 0 || size > 200) throw new Error('sizeUsd must be > 0 and <= 200');
  const slip = Number(slippageBps);
  if (!Number.isFinite(slip) || slip < 10 || slip > 500) throw new Error('slippageBps must be 10-500');

  const args = [
    TEST_TRADE_SCRIPT,
    '--buy', buyChain,
    '--sell', sellChain,
    '--size', String(size),
    '--slippage', String(slip),
    '--force',
    '--yes',
  ];
  crossChainDustState = {
    active: true,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    error: null,
    command: `node sdk/test-trade.js --buy ${buyChain} --sell ${sellChain} --size ${size} --slippage ${slip} --force --yes`,
    output: '',
  };

  const child = spawn('node', args, {
    cwd: PAXIOM_DIR,
    env: { ...process.env, PAXIOM_DIR, OPERATOR_KEY_FILE: KEY_FILE },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const append = (chunk) => {
    crossChainDustState.output += chunk.toString();
    if (crossChainDustState.output.length > 20000) {
      crossChainDustState.output = crossChainDustState.output.slice(-20000);
    }
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.on('error', (e) => {
    crossChainDustState.error = e.message;
    crossChainDustState.active = false;
    crossChainDustState.finishedAt = new Date().toISOString();
  });
  child.on('exit', (code, signal) => {
    crossChainDustState.exitCode = code ?? signal;
    crossChainDustState.active = false;
    crossChainDustState.finishedAt = new Date().toISOString();
  });
  return { started: true, command: crossChainDustState.command };
}

async function sendNativeEth(chain, to, amount) {
  if (!RPCS[chain]) throw new Error(`unknown chain ${chain}`);
  if (!isAddress(to)) throw new Error('to must be a 20-byte hex address');
  const hash = await walletClients[chain].sendTransaction({
    to, value: amount, gas: 21_000n,
  });
  return { hash, chain, asset: 'eth', to, amount: amount.toString() };
}

function validateOperatorRebalance({ fromChain = 'base', toChain, toAsset, amount } = {}) {
  if (fromChain !== 'base') throw new Error('only Base ETH source rebalancing is enabled for now');
  if (!LIFI_CHAIN_IDS[toChain]) throw new Error(`unknown toChain ${toChain}`);
  if (!LIFI_TOKENS[toChain]?.[toAsset]) throw new Error(`unknown toAsset ${toAsset}`);
  if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) throw new Error('amount must be positive');
  return { fromChain, toChain, toAsset, amount: Number(amount) };
}

async function quoteOperatorRebalance(opts = {}) {
  const { fromChain, toChain, toAsset, amount } = validateOperatorRebalance(opts);
  const toAmount = parseAmount(toAsset, amount).toString();
  const quoteUrl = new URL('https://li.quest/v1/quote/toAmount');
  quoteUrl.search = new URLSearchParams({
    fromChain: String(LIFI_CHAIN_IDS[fromChain]),
    toChain: String(LIFI_CHAIN_IDS[toChain]),
    fromToken: 'ETH',
    toToken: LIFI_TOKENS[toChain][toAsset],
    fromAddress: operatorAccount.address,
    toAddress: operatorAccount.address,
    toAmount,
    slippage: '0.01',
    order: 'CHEAPEST',
    integrator: 'paxiom',
  }).toString();
  const resp = await fetch(quoteUrl, { headers: { Accept: 'application/json' } });
  const text = await resp.text();
  let quote;
  try { quote = JSON.parse(text); } catch { quote = { message: text.slice(0, 500) }; }
  if (!resp.ok) throw new Error(quote.message || quote.error || `quote failed (${resp.status})`);
  return {
    fromChain,
    toChain,
    toAsset,
    requestedAmount: amount,
    provider: quote.toolDetails?.name || quote.tool || 'bridge provider',
    tool: quote.tool,
    fromAmount: quote.action?.fromAmount || null,
    toAmount: quote.estimate?.toAmount || toAmount,
    transactionRequest: quote.transactionRequest,
  };
}

async function executeOperatorRebalance(opts = {}) {
  const quote = await quoteOperatorRebalance(opts);
  const tx = quote.transactionRequest;
  if (!tx?.to || !tx?.data) throw new Error('quote did not include a transaction request');
  const value = BigInt(tx.value || '0x0');
  const currentBaseEth = await withRpcRetry('operator base eth before rebalance', () =>
    publicClients[quote.fromChain].getBalance({ address: operatorAccount.address }));
  const gasReserve = 100_000_000_000_000n; // 0.0001 ETH
  if (currentBaseEth < value + gasReserve) {
    throw new Error(`insufficient Base ETH for rebalance: have ${Number(currentBaseEth) / 1e18}, need ${(Number(value + gasReserve) / 1e18)}`);
  }
  const hash = await walletClients[quote.fromChain].sendTransaction({
    to: tx.to,
    value,
    data: tx.data,
    gas: tx.gasLimit ? BigInt(tx.gasLimit) : undefined,
  });
  appendFileSync(join(PAXIOM_DIR, 'operator-rebalances.log'), JSON.stringify({
    at: new Date().toISOString(),
    hash,
    fromChain: quote.fromChain,
    toChain: quote.toChain,
    toAsset: quote.toAsset,
    requestedAmount: quote.requestedAmount,
    provider: quote.provider,
    fromAmount: quote.fromAmount,
    toAmount: quote.toAmount,
  }) + '\n');
  return { broadcast: true, hash, ...quote, transactionRequest: undefined };
}

async function withRpcRetry(label, fn, attempts = 6) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      const m = String(e?.message || '');
      if (!(m.includes('over rate limit') || m.includes('429') || m.includes('Too Many Requests'))) throw e;
      // 1s, 2s, 4s, 8s, 16s, 32s — total worst case 63s before giving up.
      const wait = 1000 * Math.pow(2, i);
      console.log(`[arb-runner] ${label} 429 — retrying in ${wait}ms (${i + 1}/${attempts})`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

async function getBalances(addr) {
  const out = {};
  // Sequential per-chain (3 calls each) to avoid hammering free-tier RPCs.
  // Chains stay parallel since they're independent endpoints.
  await Promise.all(Object.keys(TOKENS).map(async (chain) => {
    try {
      const usdc = await withRpcRetry(`${chain} usdc`, () =>
        publicClients[chain].readContract({ address: TOKENS[chain].usdc, abi: ERC20_ABI, functionName: 'balanceOf', args: [addr] }));
      const weth = await withRpcRetry(`${chain} weth`, () =>
        publicClients[chain].readContract({ address: TOKENS[chain].weth, abi: ERC20_ABI, functionName: 'balanceOf', args: [addr] }));
      const native = await withRpcRetry(`${chain} native`, () =>
        publicClients[chain].getBalance({ address: addr }));
      out[chain] = {
        usdc:   Number(usdc) / 1e6,
        weth:   Number(weth) / 1e18,
        native: Number(native) / 1e18,
        ok: true,
      };
    } catch (e) {
      out[chain] = { ok: false, error: e.message.slice(0, 120) };
    }
  }));
  return out;
}

// ─── child process management ─────────────────────────────────
const state = {
  service: 'ARB-RUNNER',
  child: null,
  startedAt: null,
  stoppedAt: null,
  exitCode: null,
  emergencyClosed: false,
};

function spawnExecutor(opts = {}) {
  if (state.child) return { ok: false, reason: 'already_running' };
  if (state.emergencyClosed) {
    return { ok: false, reason: 'emergency_closed — call /v1/runner/clear-emergency first' };
  }
  // Synchronously remove the kill file before spawn so the child doesn't see it.
  if (existsSync(KILL_FILE)) {
    try { unlinkSync(KILL_FILE); } catch (e) { console.error(`[arb-runner] failed to clear kill file: ${e.message}`); }
  }
  const env = {
    ...process.env,
    PAXIOM_DIR,
    PRIVATE_KEY: OPERATOR_KEY,
    MAINNET: 'true',
    PAXIOM_TRADE_SIZE_USDC: String(opts.tradeSizeUsd || process.env.PAXIOM_TRADE_SIZE_USDC || 500),
    PAXIOM_SLIPPAGE_BPS:    String(opts.slippageBps  || process.env.PAXIOM_SLIPPAGE_BPS    || 50),
    PAXIOM_MIN_SPREAD:      String(opts.minSpread    || process.env.PAXIOM_MIN_SPREAD      || 0.30),
  };
  const child = spawn('node', [EXECUTOR_SCRIPT], {
    cwd: PAXIOM_DIR, env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  state.child = child;
  state.startedAt = new Date().toISOString();
  state.stoppedAt = null;
  state.exitCode = null;
  state.emergencyClosed = false;
  child.on('exit', (code, signal) => {
    state.child = null;
    state.stoppedAt = new Date().toISOString();
    state.exitCode = code ?? signal;
    console.log(`[arb-runner] executor exited (code=${code} signal=${signal})`);
  });
  child.on('error', (err) => console.error(`[arb-runner] executor error: ${err.message}`));
  console.log(`[arb-runner] executor spawned pid=${child.pid} trade=$${env.PAXIOM_TRADE_SIZE_USDC}`);
  return { ok: true, pid: child.pid };
}

function clearEmergency() {
  state.emergencyClosed = false;
  if (existsSync(KILL_FILE)) {
    try { unlinkSync(KILL_FILE); } catch {}
  }
  return state;
}

function stopExecutor() {
  if (!state.child) return state;
  state.child.kill('SIGTERM');
  return state;
}

function emergencyClose() {
  // Touch the kill file so the executor refuses any in-flight or future trades.
  try {
    appendFileSync(KILL_FILE, `closed:${new Date().toISOString()}\n`);
    chmodSync(KILL_FILE, 0o600);
  } catch {}
  state.emergencyClosed = true;
  if (state.child) state.child.kill('SIGTERM');
  return state;
}

// ─── performance metrics ──────────────────────────────────────
function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function performance() {
  const exec = readJsonl(EXEC_LOG);
  const unwind = readJsonl(UNWIND_LOG);
  let attempts = 0, broadcastSuccess = 0, errors = 0, estProfitUsd = 0;
  for (const r of exec) {
    attempts++;
    if (r.status === 'broadcast_success') broadcastSuccess++;
    if (r.status === 'error') errors++;
    if (typeof r.estimatedProfit === 'number') estProfitUsd += r.estimatedProfit;
  }
  let bothOk = 0, bothFail = 0, halfBuy = 0, halfSell = 0;
  for (const r of unwind) {
    if (r.category === 'BOTH_OK')   bothOk++;
    if (r.category === 'BOTH_FAIL') bothFail++;
    if (r.category === 'HALF_BUY')  halfBuy++;
    if (r.category === 'HALF_SELL') halfSell++;
  }
  const halfFills = halfBuy + halfSell;
  const confirmedTotal = bothOk + bothFail + halfFills;
  const halfFillRate = confirmedTotal ? halfFills / confirmedTotal : 0;
  const fillRate = confirmedTotal ? bothOk / confirmedTotal : 0;
  const lastExec = exec.length ? exec[exec.length - 1] : null;
  return {
    attempts, broadcastSuccess, errors,
    estProfitUsd: Math.round(estProfitUsd * 100) / 100,
    confirmed: { bothOk, bothFail, halfBuy, halfSell, halfFillRate, fillRate },
    lastAttemptAt: lastExec?.timestamp || null,
  };
}

// ─── http app ────────────────────────────────────────────────
function synthHash(chain) {
  return `0x${chain.slice(0, 8).padEnd(8, '0')}${'00'.repeat(28)}`;
}

function injectSyntheticCrossChainTrade({
  category = 'BOTH_OK',
  buyChain = 'optimism',
  sellChain = 'base',
  source = 'TEST-CROSS-CHAIN-LOOP',
  spreadPct = '0.30',
  asset = 'ETH',
} = {}) {
  if (!TOKENS[buyChain]) throw new Error(`unknown buyChain ${buyChain}`);
  if (!TOKENS[sellChain]) throw new Error(`unknown sellChain ${sellChain}`);
  if (buyChain === sellChain) throw new Error('buyChain and sellChain must differ');
  if (!['BOTH_OK', 'BOTH_FAIL', 'HALF_BUY', 'HALF_SELL'].includes(category)) {
    throw new Error(`unsupported synthetic category ${category}`);
  }

  const tradeId = `synthetic-${Date.now()}`;
  const oppTs = new Date(Date.now() - 1000).toISOString();
  const entry = {
    timestamp: new Date().toISOString(),
    tradeId,
    opportunityId: `synthetic|${oppTs}|${asset}|${buyChain}->${sellChain}|${spreadPct}`,
    sourceTimestamp: oppTs,
    source,
    asset,
    spreadPct,
    buyChain,
    sellChain,
    chainATxHash: synthHash(buyChain),
    chainBTxHash: synthHash(sellChain),
    timingGapMs: 0,
    status: 'broadcast_success',
    estimatedProfit: 0,
    synthetic: true,
    forcedCategory: category,
    venueMode: 'synthetic',
    noTransactions: true,
  };
  appendFileSync(EXEC_LOG, JSON.stringify(entry) + '\n');
  return { injected: true, tradeId, forcedCategory: category, buyChain, sellChain, noTransactions: true };
}

export function createApp() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true, service: 'ARB-RUNNER' });
    if (url.pathname === '/v1/runner/status') {
      return sendJson(res, 200, {
        service: 'ARB-RUNNER',
        running: !!state.child,
        pid: state.child?.pid ?? null,
        startedAt: state.startedAt,
        stoppedAt: state.stoppedAt,
        exitCode: state.exitCode,
        emergencyClosed: state.emergencyClosed,
        killFilePresent: existsSync(KILL_FILE),
      });
    }
    if (url.pathname === '/v1/runner/wallet') {
      const balances = await getBalances(operatorAccount.address);
      return sendJson(res, 200, {
        address: operatorAccount.address,
        balances,
      });
    }
    if (url.pathname === '/v1/runner/external-wallet') {
      const addr = url.searchParams.get('address');
      if (!isAddress(addr)) return sendJson(res, 400, { error: 'address required (0x...)' });
      const balances = await getBalances(addr);
      return sendJson(res, 200, { address: addr, balances });
    }
    if (url.pathname === '/v1/runner/withdraw') {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
      let body;
      try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
      const { chain, asset, amount, to } = body || {};
      try {
        let result;
        if (asset === 'eth') {
          // Native ETH transfer — 18 decimals
          const baseUnits = parseAmount('weth', amount); // reuse 18-dec parser
          result = await sendNativeEth(chain, to, baseUnits);
        } else {
          const baseUnits = parseAmount(asset, amount);
          result = await sendErc20(chain, asset, to, baseUnits);
        }
        appendFileSync(join(PAXIOM_DIR, 'withdrawals.log'),
          JSON.stringify({ at: new Date().toISOString(), ...result }) + '\n');
        return sendJson(res, 200, result);
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }
    if (url.pathname === '/v1/runner/performance') {
      return sendJson(res, 200, performance());
    }
    if (url.pathname === '/v1/runner/trades') {
      // Coherent trade list: one entry per execution.log row, joined with the
      // unwind monitor's classification (if available). Excludes synthetic
      // test-injection entries unless ?includeSynthetic=1.
      const includeSynthetic = url.searchParams.get('includeSynthetic') === '1';
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 30)));
      const exec = readJsonl(EXEC_LOG);
      const unwind = readJsonl(UNWIND_LOG);
      const unwindByTrade = new Map();
      const unwindByExecTs = new Map();
      for (const u of unwind) {
        if (u.tradeId) unwindByTrade.set(u.tradeId, u);
        if (u.execTimestamp) unwindByExecTs.set(u.execTimestamp, u);
      }
      const trades = exec
        .filter((e) => includeSynthetic || !e.synthetic)
        .slice(-limit)
        .reverse()
        .map((e) => {
          const u = (e.tradeId && unwindByTrade.get(e.tradeId)) || unwindByExecTs.get(e.timestamp) || null;
          return {
            tradeId: e.tradeId || null,
            opportunityId: e.opportunityId || null,
            sourceTimestamp: e.sourceTimestamp || null,
            execTimestamp: e.timestamp,
            source: e.source, asset: e.asset, spreadPct: e.spreadPct,
            buyChain: e.buyChain, sellChain: e.sellChain,
            buyTxHash: e.chainATxHash, sellTxHash: e.chainBTxHash,
            broadcastStatus: e.status,
            estimatedProfit: e.estimatedProfit,
            synthetic: e.synthetic === true,
            outcome: u ? {
              category: u.category, detectedAt: u.detectedAt,
              buyState: u.buyTx?.state, sellState: u.sellTx?.state,
              unwound: u.unwind?.acted === true,
            } : { category: 'pending' },
          };
        });
      return sendJson(res, 200, { count: trades.length, trades });
    }
    if (url.pathname === '/v1/runner/preflight') {
      const tradeSizeUsd = Number(url.searchParams.get('tradeSizeUsd') || 500);
      const balances = await getBalances(operatorAccount.address);
      const checks = [];
      const minUsdc = tradeSizeUsd * 1.1; // 10% buffer
      const minWeth = (tradeSizeUsd / 2000) * 1.1; // assume $2k/ETH conservative
      const minNative = 0.001; // gas headroom
      let readyChainPairs = 0;
      const chainState = {};
      for (const chain of Object.keys(balances)) {
        const b = balances[chain];
        const issues = [];
        if (!b.ok) issues.push(`balance read failed: ${b.error}`);
        else {
          if (b.usdc < minUsdc)     issues.push(`USDC ${b.usdc.toFixed(2)} < ${minUsdc.toFixed(2)} needed`);
          if (b.weth < minWeth)     issues.push(`WETH ${b.weth.toFixed(4)} < ${minWeth.toFixed(4)} needed`);
          if (b.native < minNative) issues.push(`gas ETH ${b.native.toFixed(4)} < ${minNative} needed`);
        }
        chainState[chain] = { ok: issues.length === 0, issues, balance: b };
        if (chainState[chain].ok) readyChainPairs++;
      }
      checks.push({ id: 'kill_file_absent',  ok: !existsSync(KILL_FILE), detail: existsSync(KILL_FILE) ? 'kill file present' : 'absent' });
      checks.push({ id: 'not_in_emergency',  ok: !state.emergencyClosed, detail: state.emergencyClosed ? 'emergency closed' : 'clear' });
      checks.push({ id: 'engine_not_running', ok: !state.child, detail: state.child ? `already running (pid ${state.child.pid})` : 'idle' });
      checks.push({ id: 'at_least_two_chains_funded', ok: readyChainPairs >= 2, detail: `${readyChainPairs}/3 chains have sufficient inventory` });
      const allOk = checks.every((c) => c.ok);
      return sendJson(res, 200, { ok: allOk, tradeSizeUsd, checks, perChain: chainState });
    }
    if (url.pathname === '/v1/runner/balance-plan') {
      try {
        const balances = await getBalances(operatorAccount.address);
        const plan = buildBalancePlan({
          balances,
          tradeSizeUsd: Number(url.searchParams.get('tradeSizeUsd') || 500),
          buyChain: url.searchParams.get('buyChain') || 'optimism',
          sellChain: url.searchParams.get('sellChain') || 'base',
          strategy: url.searchParams.get('strategy') || 'route',
          bufferPct: Number(url.searchParams.get('bufferPct') || 10),
          gasEth: Number(url.searchParams.get('gasEth') || 0.001),
        });
        return sendJson(res, 200, { operator: operatorAccount.address, ...plan });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }
    if (url.pathname === '/v1/runner/operator-rebalance-quote') {
      try {
        return sendJson(res, 200, await quoteOperatorRebalance({
          fromChain: url.searchParams.get('fromChain') || 'base',
          toChain: url.searchParams.get('toChain') || '',
          toAsset: url.searchParams.get('toAsset') || '',
          amount: url.searchParams.get('amount') || '',
        }));
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }
    if (url.pathname === '/v1/runner/operator-rebalance') {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
      let body = {};
      try { body = await readJsonBody(req); } catch {}
      try {
        return sendJson(res, 200, await executeOperatorRebalance(body || {}));
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }
    if (url.pathname === '/v1/runner/start') {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
      let body = {};
      try { body = await readJsonBody(req); } catch {}
      const result = spawnExecutor(body || {});
      const status = result.ok ? 200 : 409;
      return sendJson(res, status, { ...result, running: !!state.child, pid: state.child?.pid ?? null });
    }
    if (url.pathname === '/v1/runner/test-roundtrip') {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
      let body = {};
      try { body = await readJsonBody(req); } catch {}
      const ethAmount = Number(body.ethAmount || 0.005);
      if (roundTripState.active) return sendJson(res, 409, { error: 'round_trip_in_progress' });
      // Fire-and-forget — UI polls /v1/runner/test-roundtrip-status for progress.
      runRoundTripBase({ ethAmount, slippageBps: Number(body.slippageBps || 50) }).catch((e) => {
        console.error(`[arb-runner] round-trip error: ${e.message}`);
      });
      return sendJson(res, 202, { started: true, ethAmount });
    }
    if (url.pathname === '/v1/runner/test-roundtrip-status') {
      return sendJson(res, 200, roundTripState);
    }
    if (url.pathname === '/v1/runner/test-crosschain-dust') {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
      let body = {};
      try { body = await readJsonBody(req); } catch {}
      try {
        return sendJson(res, 202, startCrossChainDustTest({
          buyChain: body.buyChain || 'optimism',
          sellChain: body.sellChain || 'base',
          sizeUsd: body.sizeUsd || 1,
          slippageBps: body.slippageBps || 50,
        }));
      } catch (e) {
        return sendJson(res, 409, { error: e.message });
      }
    }
    if (url.pathname === '/v1/runner/test-crosschain-dust-status') {
      return sendJson(res, 200, crossChainDustState);
    }
    if (url.pathname === '/v1/runner/test-half-fill') {
      // Inject a synthetic execution.log entry that simulates a half-filled
      // cross-chain trade. The unwind monitor (running as a sidecar) sees it on
      // its next poll, fetches receipts (one valid-shape hash that won't have a
      // receipt + one all-zeros hash), and classifies as HALF_BUY or HALF_SELL.
      // This proves the detection path end-to-end without broadcasting real txs.
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
      let body = {};
      try { body = await readJsonBody(req); } catch {}
      const which = (body.which === 'sell') ? 'sell' : 'buy';
      const buyChain  = body.buyChain  || 'optimism';
      const sellChain = body.sellChain || 'base';
      // The forcedCategory tells the unwind monitor to bypass receipt fetching
      // and route directly. The synthetic flag prevents this entry from being
      // counted in real performance metrics.
      const forcedCategory = which === 'sell' ? 'HALF_BUY' : 'HALF_SELL';
      try {
        return sendJson(res, 200, injectSyntheticCrossChainTrade({
          category: forcedCategory,
          buyChain,
          sellChain,
          source: 'TEST-HALF-FILL',
        }));
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }
    if (url.pathname === '/v1/runner/test-crosschain-loop') {
      // Full Paxiom loop rehearsal without any venue dependency. This proves the
      // execution log -> unwind monitor -> UI trade-list path separately from a
      // Uniswap/router path test.
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
      let body = {};
      try { body = await readJsonBody(req); } catch {}
      try {
        return sendJson(res, 200, injectSyntheticCrossChainTrade({
          category: body.category || 'BOTH_OK',
          buyChain: body.buyChain || 'optimism',
          sellChain: body.sellChain || 'base',
          source: 'TEST-CROSS-CHAIN-LOOP',
          spreadPct: String(body.spreadPct || '0.30'),
          asset: body.asset || 'ETH',
        }));
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }
    if (url.pathname === '/v1/runner/clear-emergency') {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
      clearEmergency();
      return sendJson(res, 200, { emergencyClosed: false, killFilePresent: existsSync(KILL_FILE) });
    }
    if (url.pathname === '/v1/runner/stop') {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
      stopExecutor();
      return sendJson(res, 200, { stopping: true });
    }
    if (url.pathname === '/v1/runner/emergency-close') {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
      emergencyClose();
      return sendJson(res, 200, { emergencyClosed: true });
    }
    return notFound(res);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.on('SIGTERM', () => { stopExecutor(); setTimeout(() => process.exit(0), 500); });
  process.on('SIGINT',  () => { stopExecutor(); setTimeout(() => process.exit(0), 500); });
  createApp().listen(PORT, HOST, () => {
    console.log(`arb-runner service listening on http://${HOST}:${PORT}`);
    console.log(`[arb-runner] fund this address to deploy capital: ${operatorAccount.address}`);
  });
}
