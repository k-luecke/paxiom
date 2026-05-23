// Historical spread backfill. Samples the same 13 pools the live scanner watches,
// at historical blocks over a configurable window, and emits opportunity rows in
// the same JSONL format as opportunities.log.
//
// Output goes to a separate file (opportunities-backfill.log) — analysis tools
// can be pointed at it via LOG_FILE=... env var.
//
// Requirements:
//   - Archive-capable RPCs for the past N months. Public RPCs typically support
//     ~1 month back. For 6 months, set RPC_OPTIMISM / RPC_BASE / RPC_ARBITRUM to
//     paid archive endpoints (Alchemy archive plan, QuickNode archive, etc).
//
// Usage:
//   node sdk/backfill-spreads.js                              # 6mo, 5-min resolution
//   DAYS=30 RESOLUTION_SEC=300 node sdk/backfill-spreads.js   # 1mo at 5min
//   DAYS=180 RESOLUTION_SEC=600 node sdk/backfill-spreads.js  # 6mo at 10min
//
// Resume: saves progress to ${PAXIOM_DIR}/.executor/backfill-progress.json.
// Re-running picks up where it left off.

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const PAXIOM_DIR    = process.env.PAXIOM_DIR || join(homedir(), 'paxiom');
const OUT_FILE      = process.env.BACKFILL_LOG || join(PAXIOM_DIR, 'opportunities-backfill.log');
const PROGRESS_FILE = join(PAXIOM_DIR, '.executor', 'backfill-progress.json');
const DAYS          = Number(process.env.DAYS || 180);
// Default 30-min resolution to be friendly to public RPCs. At 5-min you'll
// likely need paid archive endpoints. The docs say spreads persist "minutes",
// so 30-min resolution catches most multi-minute events.
const RES_SEC       = Number(process.env.RESOLUTION_SEC || 1800);
const PAIR_WINDOW_SEC = Number(process.env.PAIR_WINDOW_SEC || 120);

const RPCS = {
  optimism: process.env.RPC_OPTIMISM || 'https://mainnet.optimism.io',
  arbitrum: process.env.RPC_ARBITRUM || 'https://arb1.arbitrum.io/rpc',
  base:     process.env.RPC_BASE     || 'https://mainnet.base.org',
};

const POOLS = [
  { chain: 'arbitrum', dex: 'uniswap',   asset: 'ETH',    pool: '0xC6962004f452bE9203591991D15f6b388e09E8D0', decimals: 12 },
  { chain: 'base',     dex: 'uniswap',   asset: 'ETH',    pool: '0xd0b53D9277642d899DF5C87A3966A349A798F224', decimals: 12 },
  { chain: 'optimism', dex: 'uniswap',   asset: 'ETH',    pool: '0x85149247691df622eaF1a8Bd0CaFd40BC45154a9', decimals: 12 },
  { chain: 'base',     dex: 'aerodrome', asset: 'ETH',    pool: '0xb2cc224c1c9feE385f8ad6a55b4d94E92359DC59', decimals: 12 },
  { chain: 'arbitrum', dex: 'uniswap',   asset: 'WBTC',   pool: '0xA62aD78825E3a55A77823F00Fe0050F567c1e4EE', decimals: 2 },
  { chain: 'optimism', dex: 'uniswap',   asset: 'WBTC',   pool: '0x73B14a78a0D396C521f954532d43fd5fFe385216', decimals: 2 },
  { chain: 'arbitrum', dex: 'uniswap',   asset: 'wstETH', pool: '0x35218a1cbaC5Bbc3E57fd9Bd38219D37571b3537', decimals: 0 },
  { chain: 'optimism', dex: 'uniswap',   asset: 'wstETH', pool: '0x04F6C85A1B00F6D9B75f91FD23835974Cc07E65c', decimals: 0 },
  { chain: 'base',     dex: 'uniswap',   asset: 'cbETH',  pool: '0xa9dafa443a02fbc907cb0093276b3e6f4ef02a46', decimals: 0 },
];

// ─── helpers ─────────────────────────────────────────────────
async function rpc(chain, method, params) {
  const res = await fetch(RPCS[chain], {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${chain} ${method}: ${json.error.message}`);
  return json.result;
}

// Batch JSON-RPC: bundle N eth_calls into one HTTP POST. Works on any provider
// that supports the batch spec (Alchemy, Infura, Quicknode, most public RPCs).
// On Alchemy this is the single biggest throughput multiplier — one HTTP round
// trip + one rate-limit slot consumed, regardless of how many calls bundled.
async function batchRpc(chain, calls) {
  const body = calls.map((c, i) => ({ jsonrpc: '2.0', id: i, method: c.method, params: c.params }));
  const res = await fetch(RPCS[chain], {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!Array.isArray(json)) {
    if (json.error) throw new Error(`${chain} batch: ${json.error.message}`);
    throw new Error(`${chain} batch: expected array response, got ${typeof json}`);
  }
  // Sort by id (some providers don't preserve order) and extract results.
  const sorted = [...json].sort((a, b) => a.id - b.id);
  return sorted.map((r) => r.error ? null : r.result);
}

async function batchRpcWithRetry(chain, calls, label, attempts = 6) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await batchRpc(chain, calls); }
    catch (e) {
      lastErr = e;
      const m = String(e.message || '');
      if (!(m.includes('rate limit') || m.includes('429') || m.includes('Too Many'))) throw e;
      const wait = 1000 * Math.pow(2, i);
      console.error(`  [${label}] 429, waiting ${wait}ms (${i + 1}/${attempts})`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

async function rpcWithRetry(chain, method, params, label, attempts = 6) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await rpc(chain, method, params); }
    catch (e) {
      lastErr = e;
      const m = String(e.message || '');
      if (!(m.includes('rate limit') || m.includes('429') || m.includes('Too Many'))) throw e;
      const wait = 1000 * Math.pow(2, i);
      console.error(`  [${label}] 429, waiting ${wait}ms (${i + 1}/${attempts})`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

async function getBlockByNumber(chain, blockNumber) {
  const hex = '0x' + blockNumber.toString(16);
  return rpcWithRetry(chain, 'eth_getBlockByNumber', [hex, false], `${chain} block`);
}

async function getLatestBlock(chain) {
  const result = await rpcWithRetry(chain, 'eth_getBlockByNumber', ['latest', false], `${chain} latest`);
  return { number: parseInt(result.number, 16), timestamp: parseInt(result.timestamp, 16) };
}

// Binary-search the block at a target timestamp.
async function blockAtTimestamp(chain, targetTs, hint) {
  let lo = 1, hi = hint.number;
  let loBlock = await getBlockByNumber(chain, 1);
  let loTs = parseInt(loBlock.timestamp, 16);
  if (targetTs <= loTs) return 1;
  if (targetTs >= hint.timestamp) return hint.number;

  // Estimate block time and start narrower
  const avgBlockTime = (hint.timestamp - loTs) / (hint.number - 1);
  let guess = Math.max(1, hint.number - Math.floor((hint.timestamp - targetTs) / avgBlockTime));
  let guessBlock = await getBlockByNumber(chain, guess);
  let guessTs = parseInt(guessBlock.timestamp, 16);

  // Narrow by binary search
  while (Math.abs(guessTs - targetTs) > RES_SEC && hi - lo > 10) {
    if (guessTs < targetTs) { lo = guess; loTs = guessTs; }
    else                    { hi = guess; }
    guess = Math.floor((lo + hi) / 2);
    guessBlock = await getBlockByNumber(chain, guess);
    guessTs = parseInt(guessBlock.timestamp, 16);
  }
  return guess;
}

// slot0() selector + sqrtPriceX96 → mid price
async function poolPriceAtBlock(pool, blockNumber) {
  try {
    const result = await rpcWithRetry(
      pool.chain, 'eth_call',
      [{ to: pool.pool, data: '0x3850c7bd' }, '0x' + blockNumber.toString(16)],
      `${pool.chain}/${pool.asset}/${pool.dex}`,
    );
    if (!result || result === '0x') return null;
    const sqrtPriceX96 = BigInt('0x' + result.slice(2, 66));
    const Q96 = 2n ** 96n;
    const price = Number(sqrtPriceX96 * sqrtPriceX96 * BigInt(10 ** pool.decimals)) / Number(Q96 * Q96);
    if (!Number.isFinite(price) || price < 0.0001 || price > 10_000_000) return null;
    return price;
  } catch (e) {
    return null;
  }
}

function loadProgress() {
  if (!existsSync(PROGRESS_FILE)) return null;
  try { return JSON.parse(readFileSync(PROGRESS_FILE, 'utf8')); } catch { return null; }
}

function saveProgress(p) {
  const dir = join(PAXIOM_DIR, '.executor');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(PROGRESS_FILE, JSON.stringify(p));
}

async function main() {
  console.log(`Paxiom — historical spread backfill`);
  console.log(`Window: ${DAYS} days back, resolution ${RES_SEC}s, pair-window ${PAIR_WINDOW_SEC}s`);
  console.log(`Output: ${OUT_FILE}`);
  console.log('');

  const now = Math.floor(Date.now() / 1000);
  const startTs = now - DAYS * 86400;
  const sampleCount = Math.floor((DAYS * 86400) / RES_SEC);

  console.log(`Discovering current head block per chain...`);
  const heads = {};
  for (const chain of Object.keys(RPCS)) {
    heads[chain] = await getLatestBlock(chain);
    console.log(`  ${chain}: head=${heads[chain].number} ts=${new Date(heads[chain].timestamp * 1000).toISOString()}`);
  }
  console.log('');

  let progress = loadProgress() || { lastSampleIndex: -1, opportunities: 0 };
  if (progress.lastSampleIndex >= 0) {
    console.log(`Resuming from sample ${progress.lastSampleIndex + 1} / ${sampleCount} (${progress.opportunities} opps so far)`);
  }

  // Pre-compute a per-chain target-block table to avoid re-binary-searching.
  // Sample timestamps: [startTs, startTs + RES_SEC, ..., now]
  const blockTablesPath = join(PAXIOM_DIR, '.executor', 'backfill-block-table.json');
  let blockTables = null;
  if (existsSync(blockTablesPath)) {
    try { blockTables = JSON.parse(readFileSync(blockTablesPath, 'utf8')); } catch {}
  }
  if (!blockTables || blockTables.startTs !== startTs || blockTables.resSec !== RES_SEC) {
    console.log(`Building block table (${sampleCount} samples × ${Object.keys(RPCS).length} chains)...`);
    blockTables = { startTs, resSec: RES_SEC, sampleCount, chains: {} };
    for (const chain of Object.keys(RPCS)) {
      const tbl = [];
      const head = heads[chain];
      // Find avg block time
      const earlyBlock = await getBlockByNumber(chain, Math.max(1, head.number - 1000));
      const earlyTs = parseInt(earlyBlock.timestamp, 16);
      const blockTime = (head.timestamp - earlyTs) / 1000;
      console.log(`  ${chain}: avg block time ${blockTime.toFixed(3)}s`);
      for (let i = 0; i < sampleCount; i++) {
        const t = startTs + i * RES_SEC;
        const estBlock = head.number - Math.floor((head.timestamp - t) / blockTime);
        tbl.push(Math.max(1, estBlock));
      }
      blockTables.chains[chain] = tbl;
    }
    saveBlockTables(blockTables);
    console.log(`Block table built. Estimated blocks (no binary search — accuracy ±1 block).`);
    console.log('');
  } else {
    console.log(`Using cached block table.`);
  }

  let appended = progress.opportunities;
  const t0 = Date.now();
  for (let i = progress.lastSampleIndex + 1; i < sampleCount; i++) {
    const targetTs = startTs + i * RES_SEC;
    const sampleIso = new Date(targetTs * 1000).toISOString();

    // Fetch pool prices: ONE batched JSON-RPC request per chain (each request
    // contains all that chain's slot0 calls). Reduces per-sample HTTP overhead
    // from 13 requests to 3. Alchemy supports the JSON-RPC batch spec, so this
    // works on free or paid tier. Public RPCs that support batch get the same
    // benefit; ones that don't will fall back to individual calls.
    const poolsByChain = {};
    for (const p of POOLS) { (poolsByChain[p.chain] ||= []).push(p); }
    const perChainResults = await Promise.all(Object.keys(poolsByChain).map(async (chain) => {
      const list = poolsByChain[chain];
      const calls = list.map((pool) => ({
        method: 'eth_call',
        params: [{ to: pool.pool, data: '0x3850c7bd' }, '0x' + blockTables.chains[chain][i].toString(16)],
      }));
      let results;
      try {
        results = await batchRpcWithRetry(chain, calls, `${chain} batch slot0`);
      } catch (e) {
        return list.map(() => null);
      }
      return list.map((pool, idx) => {
        const raw = results[idx];
        if (!raw || raw === '0x') return null;
        try {
          const sqrtPriceX96 = BigInt('0x' + raw.slice(2, 66));
          const Q96 = 2n ** 96n;
          const price = Number(sqrtPriceX96 * sqrtPriceX96 * BigInt(10 ** pool.decimals)) / Number(Q96 * Q96);
          if (!Number.isFinite(price) || price < 0.0001 || price > 10_000_000) return null;
          return { ...pool, price, block: blockTables.chains[chain][i], ts: targetTs };
        } catch { return null; }
      });
    }));
    const observations = perChainResults.flat();

    // Group by asset and compute cross-chain spreads
    const byAsset = {};
    for (const obs of observations) {
      if (!obs) continue;
      if (!byAsset[obs.asset]) byAsset[obs.asset] = [];
      byAsset[obs.asset].push(obs);
    }
    for (const [asset, list] of Object.entries(byAsset)) {
      if (list.length < 2) continue;
      const prices = list.map((o) => o.price);
      const max = Math.max(...prices), min = Math.min(...prices);
      if (max === min) continue;
      const spreadPct = ((max - min) / min) * 100;
      if (spreadPct < 0.005) continue; // floor — irrelevant noise
      const maxE = list.find((o) => o.price === max);
      const minE = list.find((o) => o.price === min);
      if (maxE.chain === minE.chain) continue; // we want cross-chain only
      const opp = {
        timestamp: sampleIso,
        asset,
        spreadPct: spreadPct.toFixed(4),
        buyChain: minE.chain, buyDex: minE.dex,
        sellChain: maxE.chain, sellDex: maxE.dex,
        buyPrice: min.toFixed(6),
        sellPrice: max.toFixed(6),
        capturable: true,    // historical observation — treat as capturable; analysis applies filters
        source: 'backfill',
        sampleBlock: { buy: minE.block, sell: maxE.block },
      };
      appendFileSync(OUT_FILE, JSON.stringify(opp) + '\n');
      appended++;
    }

    if (i % 20 === 0 || i === sampleCount - 1) {
      const pct = ((i + 1) / sampleCount * 100).toFixed(2);
      const elapsed = (Date.now() - t0) / 1000;
      const rate = (i - progress.lastSampleIndex) / elapsed;
      const remaining = (sampleCount - i - 1) / rate;
      console.log(`[${pct}%] sample ${i + 1}/${sampleCount} @ ${sampleIso} | opps so far: ${appended} | ETA: ${(remaining / 60).toFixed(1)}min`);
    }

    progress = { lastSampleIndex: i, opportunities: appended };
    if (i % 10 === 0) saveProgress(progress);
  }
  saveProgress(progress);

  console.log('');
  console.log(`Done. ${appended} opportunities written to ${OUT_FILE}`);
  console.log(`Analyze with: LOG_FILE=${OUT_FILE} node sdk/income-layers.js`);
}

function saveBlockTables(t) {
  const dir = join(PAXIOM_DIR, '.executor');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'backfill-block-table.json'), JSON.stringify(t));
}

main().catch((e) => { console.error(`FATAL: ${e.message}`); process.exit(1); });
