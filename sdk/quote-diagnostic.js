// Quoter diagnostic — verifies mainnet Uniswap V3 quoters return non-zero output
// for USDC→WETH at the planned trade size on each chain. Run before any live trade.
//
// All 4,202 rows in opportunities.log have quoteFailed:true or no quote — meaning the
// scanner's quote path never succeeded. This script isolates which piece is broken:
// quoter address, token address, fee tier liquidity, or RPC reachability.
//
// Usage:
//   node sdk/quote-diagnostic.js                              # mainnet, $1k size
//   PAXIOM_QUOTE_SIZE_USDC=5000 node sdk/quote-diagnostic.js  # $5k probe
//   MAINNET=0 node sdk/quote-diagnostic.js                    # testnet (debug only)

import { createPublicClient, http } from 'viem';
import { optimism, arbitrum, base, optimismSepolia, arbitrumSepolia, baseSepolia } from 'viem/chains';

const MAINNET = process.env.MAINNET !== '0';
const SIZE_DOLLARS = Number(process.env.PAXIOM_QUOTE_SIZE_USDC || 1000);
const TRADE_USDC = BigInt(SIZE_DOLLARS) * 1_000000n;
const FEE_TIERS = [500, 3000, 10000]; // try standard tiers; live-executor uses 500

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
  optimism: { usdc: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', weth: '0x4200000000000000000000000000000000000006' },
  arbitrum: { usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', weth: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1' },
  base:     { usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', weth: '0x4200000000000000000000000000000000000006' },
} : {
  optimism: { usdc: '0x5fd84259d66Cd46123540766Be93DFE6D43130D7', weth: '0x4200000000000000000000000000000000000006' },
  arbitrum: { usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', weth: '0x980B62Da83eFf3D4576C647993b0c1D7faf17c73' },
  base:     { usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', weth: '0x4200000000000000000000000000000000000006' },
};

// QuoterV2 addresses; same on Optimism + Arbitrum, different on Base.
const QUOTERS = MAINNET ? {
  optimism: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  arbitrum: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  base:     '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
} : {
  optimism: '0xa132DAB612dB5cB9fC9Ac426A0Cc215A3423F9c9',
  arbitrum: '0x101F443B4d1b059569D643917553c771E1b9663E',
  base:     '0x050E797f3625EC8785265e1d9BDd4799b97528A1',
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

const RESET = '\x1b[0m', BOLD = '\x1b[1m', DIM = '\x1b[2m';
const RED = '\x1b[31m', GREEN = '\x1b[32m', YELLOW = '\x1b[33m', CYAN = '\x1b[36m';

const chainObj = (n) => (MAINNET ? { optimism, arbitrum, base } : { optimism: optimismSepolia, arbitrum: arbitrumSepolia, base: baseSepolia })[n];

async function probe(chainName, fee) {
  const client = createPublicClient({ chain: chainObj(chainName), transport: http(RPCS[chainName]) });
  const { usdc, weth } = TOKENS[chainName];
  const quoter = QUOTERS[chainName];
  try {
    const r = await client.simulateContract({
      address: quoter, abi: QUOTER_ABI, functionName: 'quoteExactInputSingle',
      args: [{ tokenIn: usdc, tokenOut: weth, amountIn: TRADE_USDC, fee, sqrtPriceLimitX96: 0n }],
    });
    const wethOut = r.result[0];
    const ticksCrossed = r.result[2];
    const wethDec = Number(wethOut) / 1e18;
    const impliedPrice = SIZE_DOLLARS / wethDec;
    return { ok: true, wethOut, wethDec, impliedPrice, ticksCrossed: Number(ticksCrossed) };
  } catch (e) {
    return { ok: false, err: e.message.split('\n')[0].slice(0, 160) };
  }
}

async function main() {
  console.log(`${BOLD}${CYAN}Paxiom quoter diagnostic${RESET}`);
  console.log(`  network: ${MAINNET ? 'mainnet' : 'testnet'}`);
  console.log(`  size:    $${SIZE_DOLLARS.toLocaleString()} (${TRADE_USDC} base units)`);
  console.log(`  pair:    USDC → WETH`);
  console.log('');

  let anyOk = false;
  for (const chain of ['optimism', 'arbitrum', 'base']) {
    console.log(`${BOLD}${chain}${RESET}  quoter=${QUOTERS[chain]}`);
    for (const fee of FEE_TIERS) {
      const r = await probe(chain, fee);
      if (r.ok) {
        anyOk = true;
        console.log(`  fee=${String(fee).padStart(5)}  ${GREEN}OK${RESET}  out=${r.wethDec.toFixed(6)} WETH  ` +
                    `≈ $${r.impliedPrice.toFixed(2)}/ETH  ticks=${r.ticksCrossed}`);
      } else {
        console.log(`  fee=${String(fee).padStart(5)}  ${RED}FAIL${RESET}  ${DIM}${r.err}${RESET}`);
      }
    }
    console.log('');
  }

  if (!anyOk) {
    console.log(`${RED}${BOLD}All probes failed.${RESET} Most likely causes:`);
    console.log(`  1. RPC unreachable (check ${MAINNET ? 'mainnet' : 'testnet'} URLs)`);
    console.log(`  2. Quoter address wrong for the network`);
    console.log(`  3. USDC/WETH addresses stale`);
    console.log(`  4. No liquidity at requested fee tier (try other tiers)`);
    process.exit(1);
  }
  console.log(`${GREEN}${BOLD}At least one probe succeeded.${RESET} Compare fee tiers — live-executor.js uses fee=500.`);
  console.log(`If fee=500 failed but other tiers succeeded, update SWAP_ABI args in live-executor.js to a working tier.`);
}

main().catch(e => { console.error(`${RED}fatal: ${e.message}${RESET}`); process.exit(1); });
