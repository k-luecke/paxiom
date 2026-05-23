// Decomposes income by friction layer across the actual logged opportunities.
// Same data, four lenses:
//   1. Gross — pure spread × capital, no costs (mirrors earlier returns-by-breakdown
//      runs in solo mode at large capital where friction was hidden by scale)
//   2. After pool fees — subtract Uniswap V3 0.10% round-trip
//   3. After fees + gas — subtract flat L2 gas $0.50
//   4. After fees + gas + slippage — realistic
//
// All four use the SAME opportunity list and the SAME timestamps. The difference
// is purely cost modeling. Helps reconcile "why did my older estimate look much
// higher than the realistic one".

import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const LOG_FILE = process.env.LOG_FILE || join(homedir(), 'paxiom', 'opportunities.log');
const POOL_TVL = Number(process.env.POOL_TVL_USD || 20_000_000);
const POOL_FEE_RATE = 0.001;
const GAS_COST = 0.50;

const CAPITAL_LEVELS = [200, 500, 1000, 2500, 5000, 10000];

function slippagePct(tradeUsd) {
  return (tradeUsd / POOL_TVL) * 0.5; // per leg
}

function loadOpps(path) {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean)
    .filter((r) => r.buyChain !== r.sellChain);
}

function analyze(opps, capital) {
  const layers = { gross: 0, afterFees: 0, afterFeesGas: 0, afterAll: 0 };
  const fires  = { gross: 0, afterFees: 0, afterFeesGas: 0, afterAll: 0 };
  for (const opp of opps) {
    const spread = parseFloat(opp.spreadPct);
    if (!Number.isFinite(spread)) continue;
    const gross  = capital * (spread / 100);
    const fees   = capital * POOL_FEE_RATE;
    const slip   = capital * slippagePct(capital) / 100 * 2;
    const gas    = GAS_COST;

    // Each layer "fires" when its net is positive.
    if (gross > 0)                          { layers.gross        += gross;                          fires.gross++; }
    if (gross - fees > 0)                   { layers.afterFees    += gross - fees;                   fires.afterFees++; }
    if (gross - fees - gas > 0)             { layers.afterFeesGas += gross - fees - gas;             fires.afterFeesGas++; }
    if (gross - fees - gas - slip > 0)      { layers.afterAll     += gross - fees - gas - slip;      fires.afterAll++; }
  }
  return { capital, layers, fires };
}

function fmt$(n) {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000)     return `$${(n / 1_000).toFixed(2)}k`;
  return `$${n.toFixed(2)}`;
}

function main() {
  const opps = loadOpps(LOG_FILE);
  const earliest = opps[0].timestamp;
  const latest = opps[opps.length - 1].timestamp;
  const days = (new Date(latest) - new Date(earliest)) / (1000 * 60 * 60 * 24);

  console.log(`Paxiom — income by friction layer`);
  console.log(`────────────────────────────────────`);
  console.log(`Real cross-chain opps:  ${opps.length}`);
  console.log(`Real window:  ${earliest}`);
  console.log(`         to:  ${latest}`);
  console.log(`Span:        ${days.toFixed(2)} days`);
  console.log('');
  console.log(`Columns are SUM net P&L over the actual window (not extrapolated).`);
  console.log(`Each column shows what gets through each cost layer.`);
  console.log('');

  const rows = CAPITAL_LEVELS.map((cap) => analyze(opps, cap));
  const w = { cap: 9, gross: 14, fees: 14, gas: 14, all: 14, daily: 13 };
  const header = [
    'per-side'.padStart(w.cap),
    'gross'.padStart(w.gross),
    'after fees'.padStart(w.fees),
    'after fees+gas'.padStart(w.gas),
    'realistic (all)'.padStart(w.all),
    'real/day'.padStart(w.daily),
  ].join(' | ');
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const r of rows) {
    const row = [
      `$${r.capital.toLocaleString()}`.padStart(w.cap),
      `${fmt$(r.layers.gross)} (${r.fires.gross})`.padStart(w.gross),
      `${fmt$(r.layers.afterFees)} (${r.fires.afterFees})`.padStart(w.fees),
      `${fmt$(r.layers.afterFeesGas)} (${r.fires.afterFeesGas})`.padStart(w.gas),
      `${fmt$(r.layers.afterAll)} (${r.fires.afterAll})`.padStart(w.all),
      `${fmt$(r.layers.afterAll / days)}`.padStart(w.daily),
    ].join(' | ');
    console.log(row);
  }
  console.log('');
  console.log(`Format: $sum (count of opps that survive that layer)`);
  console.log('');

  console.log(`Layer-by-layer cost breakdown at $1,000/side per trade:`);
  const cap = 1000;
  const slip = slippagePct(cap) * 2 * cap / 100;
  console.log(`  pool fees (0.10% round-trip): $${(cap * POOL_FEE_RATE).toFixed(2)} per trade`);
  console.log(`  gas (L2 cross-chain):         $${GAS_COST.toFixed(2)} per trade`);
  console.log(`  slippage at $${(POOL_TVL/1e6).toFixed(0)}M pool TVL:    $${slip.toFixed(4)} per trade`);
  console.log('');

  console.log(`Cross-checks against older runs:`);
  console.log(`  Earlier "solo mode" returns-by-breakdown.js at $5M capital reported ~$16M`);
  console.log(`  over the original 7-day window. That used capital × spread% − gas only`);
  console.log(`  (no pool fees, no slippage). The "gross" column above matches that model.`);
  console.log(`  The "realistic (all)" column is what you actually capture in execution.`);
}

main();
