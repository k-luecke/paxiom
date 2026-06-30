#!/usr/bin/env node
// Pre-flight fix #3 (docs/arb-live-test-plan.md:74) — one-shot mainnet quoter diagnostic.
//
// The plan's hard gate: do NOT fund wallets or go live until a real mainnet quote
// returns a non-zero wethOut. opportunities.log showed frequent quoteFailed + negative
// P&L at small size; this isolates whether the quoter path itself works.
//
// Replicates sdk/price-feeder.js exactly: same QUOTER_ADDRESSES, TOKEN_ADDRESSES,
// QUOTER_ABI, fee tier 500, and simulateContract call (the quoter fn is nonpayable).
//
// Usage:
//   node scripts/test-quoter-mainnet.mjs                 # base USDC->WETH at $1/$100/$1k/$10k
//   node scripts/test-quoter-mainnet.mjs --all-chains    # also optimism + arbitrum
//   BASE_RPC_URL=https://... node scripts/test-quoter-mainnet.mjs   # override RPC
//
// Public RPCs are the default (one-shot diagnostic only). For live trading the plan
// requires paid per-chain RPCs (docs/arb-live-test-plan.md:175).

import { createPublicClient, http, formatUnits } from 'viem';
import * as chains from 'viem/chains';

const QUOTER_ADDRESSES = {
  optimism: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  arbitrum: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  base:     '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
};

const TOKEN_ADDRESSES = {
  optimism: { USDC: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', WETH: '0x4200000000000000000000000000000000000006' },
  arbitrum: { USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', WETH: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1' },
  base:     { USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', WETH: '0x4200000000000000000000000000000000000006' },
};

const RPC_URLS = {
  optimism: process.env.OPTIMISM_RPC_URL || 'https://mainnet.optimism.io',
  arbitrum: process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc',
  base:     process.env.BASE_RPC_URL     || 'https://mainnet.base.org',
};

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
    { name: 'amountOut',               type: 'uint256' },
    { name: 'sqrtPriceX96After',       type: 'uint160' },
    { name: 'initializedTicksCrossed', type: 'uint32'  },
    { name: 'gasEstimate',             type: 'uint256' },
  ],
}];

const FEE_TIER = 500;
const SIZES_USDC = [1n, 100n, 1000n, 10000n]; // dollars
const chainMap = { optimism: chains.optimism, arbitrum: chains.arbitrum, base: chains.base };

function client(chain) {
  return createPublicClient({ chain: chainMap[chain], transport: http(RPC_URLS[chain]) });
}

// One quote: tokenIn -> tokenOut, fee 500, via simulateContract (nonpayable fn).
async function quote(c, chain, tokenIn, tokenOut, amountIn) {
  const { result } = await c.simulateContract({
    address: QUOTER_ADDRESSES[chain],
    abi: QUOTER_ABI,
    functionName: 'quoteExactInputSingle',
    args: [{ tokenIn, tokenOut, amountIn, fee: FEE_TIER, sqrtPriceLimitX96: 0n }],
  });
  return Array.isArray(result) ? result[0] : result; // amountOut
}

async function testChain(chain) {
  console.log(`\n=== ${chain.toUpperCase()} (quoter ${QUOTER_ADDRESSES[chain]}, fee ${FEE_TIER}) ===`);
  console.log(`RPC: ${RPC_URLS[chain]}`);
  const { USDC, WETH } = TOKEN_ADDRESSES[chain];
  const c = client(chain);
  let anyNonZero = false;

  for (const dollars of SIZES_USDC) {
    const amountIn = dollars * 1_000000n; // USDC has 6 decimals
    const label = `$${dollars.toString().padStart(6)} USDC->WETH`;
    try {
      const wethOut = await quote(c, chain, USDC, WETH, amountIn);
      const eth = Number(formatUnits(wethOut, 18));
      const ok = wethOut > 0n;
      anyNonZero = anyNonZero || ok;
      console.log(`  ${ok ? 'OK  ' : 'ZERO'} ${label}  ->  ${eth.toFixed(8)} WETH  (raw ${wethOut})`);
      // Round-trip the buy-leg output back to USDC to sanity-check the reverse pool.
      if (ok) {
        try {
          const usdcBack = await quote(c, chain, WETH, USDC, wethOut);
          const back = Number(formatUnits(usdcBack, 6));
          const rtPct = ((back - Number(dollars)) / Number(dollars)) * 100;
          console.log(`       round-trip WETH->USDC: $${back.toFixed(4)}  (${rtPct.toFixed(3)}% incl. 2x ${FEE_TIER/10000}% pool fee)`);
        } catch (e) {
          console.log(`       round-trip WETH->USDC FAILED: ${String(e.shortMessage || e.message).slice(0, 80)}`);
        }
      }
    } catch (e) {
      console.log(`  FAIL ${label}  ->  ${String(e.shortMessage || e.message).slice(0, 100)}`);
    }
  }
  return anyNonZero;
}

async function main() {
  const allChains = process.argv.includes('--all-chains');
  const targets = allChains ? ['base', 'optimism', 'arbitrum'] : ['base'];
  console.log('Pre-flight fix #3 — mainnet quoter diagnostic');
  console.log('Gate: a non-zero wethOut means the quote path works; proceed to funding.');

  const results = {};
  for (const chain of targets) {
    try { results[chain] = await testChain(chain); }
    catch (e) { results[chain] = false; console.log(`  CHAIN ERROR ${chain}: ${String(e.shortMessage || e.message).slice(0, 120)}`); }
  }

  console.log('\n=== VERDICT ===');
  let pass = true;
  for (const chain of targets) {
    const ok = results[chain];
    pass = pass && ok;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${chain} — quote path ${ok ? 'works (non-zero out)' : 'returned no usable quote'}`);
  }
  if (pass) {
    console.log('\nGATE CLEARED. The quoter path works on mainnet.');
    console.log('Next: Stage 1 funding (docs/arb-live-test-plan.md:138) — $1,100 USDC + 0.2 WETH per chain on Optimism + Base.');
  } else {
    console.log('\nGATE NOT CLEARED. Do not fund wallets yet. Likely causes:');
    console.log('  - wrong QUOTER address, stale USDC/WETH addresses, no liquidity in the fee-500 pool, or RPC failure.');
    console.log('  - Try a paid RPC (BASE_RPC_URL=...) to rule out public-RPC rate limiting.');
  }
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error('fatal:', e); process.exit(1); });
