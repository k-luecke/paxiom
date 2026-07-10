// Model returns at multiple capital deployment levels against the historical
// opportunities.log. Filters for cross-chain only (the engine's mode), applies
// per-size slippage estimates, pool fees, and gas.
//
// Slippage model: linear in trade_size / pool_tvl. Assumes pool_tvl = $20M
// (conservative for L2 USDC/WETH 500-tier pools). Slippage scales per-leg, so
// round-trip slippage = 2 × per-leg.
//
// Usage:
//   node sdk/capital-deployment-analysis.js
//   POOL_TVL_USD=50000000 node sdk/capital-deployment-analysis.js
//
// Fee model:
//   - Uniswap V3 fee tier 500 = 0.05% per swap = 0.10% round-trip
//   - Gas (L2 cross-chain, two chains) ≈ $0.50 round-trip
//   - No Paxiom flash fee (sole LP solo mode)

import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const LOG_FILE = process.env.LOG_FILE || join(homedir(), 'paxiom', 'opportunities.log');
const POOL_TVL = Number(process.env.POOL_TVL_USD || 20_000_000);
const POOL_FEE_RATE = 0.001;   // 0.10% round-trip
const GAS_COST = 0.50;         // $ per round-trip on L2s

const CAPITAL_LEVELS = [200, 500, 1000, 2500, 5000, 10000];

// Slippage estimate per LEG. Round trip is 2× this.
function slippagePctPerLeg(tradeUsd) {
  return (tradeUsd / POOL_TVL) * 0.5;
}

// Net P&L per opportunity at capital level.
function netPnl(tradeUsd, spreadPct) {
  const gross  = tradeUsd * (spreadPct / 100);
  const fees   = tradeUsd * POOL_FEE_RATE;
  const slip   = tradeUsd * slippagePctPerLeg(tradeUsd) / 100 * 2;
  return gross - fees - slip - GAS_COST;
}

// Breakeven gross spread (in percent) at trade size.
function breakevenSpreadPct(tradeUsd) {
  const slip = slippagePctPerLeg(tradeUsd) * 2;
  const feePct = POOL_FEE_RATE * 100;
  const gasPct = (GAS_COST / tradeUsd) * 100;
  return slip + feePct + gasPct;
}

function loadOpps(path) {
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean)
    // CROSS-CHAIN ONLY — same-chain is rejected by the executor (MEV lane).
    .filter((r) => r.buyChain !== r.sellChain);
}

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function analyze(opps, capital) {
  let captured = 0, sum = 0, posSum = 0, posCount = 0;
  const positives = [];
  for (const opp of opps) {
    const spread = parseFloat(opp.spreadPct);
    if (!Number.isFinite(spread)) continue;
    const pnl = netPnl(capital, spread);
    if (pnl > 0) {
      captured++;
      sum += pnl;
      posSum += pnl;
      posCount++;
      positives.push(pnl);
    }
  }
  return {
    capital,
    breakeven: breakevenSpreadPct(capital),
    capturedCount: captured,
    sumPnl: sum,
    meanPnl: posCount ? posSum / posCount : 0,
    medianPnl: median(positives),
    slippageRoundtripPct: slippagePctPerLeg(capital) * 2,
  };
}

function fmt$(n) {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000)     return `$${(n / 1_000).toFixed(2)}k`;
  return `$${n.toFixed(2)}`;
}

function main() {
  const opps = loadOpps(LOG_FILE);
  const totalRows = opps.length;
  const earliest = opps.length ? opps[0].timestamp : null;
  const latest = opps.length ? opps[opps.length - 1].timestamp : null;
  const days = (earliest && latest)
    ? (new Date(latest) - new Date(earliest)) / (1000 * 60 * 60 * 24)
    : 0;

  console.log('Paxiom — cross-chain capital deployment returns');
  console.log('───────────────────────────────────────────────');
  console.log(`Dataset:    ${LOG_FILE}`);
  console.log(`Cross-chain opps:  ${totalRows}`);
  console.log(`Window:     ${earliest} → ${latest}  (${days.toFixed(2)} days)`);
  console.log(`Pool TVL assumed: ${fmt$(POOL_TVL)}  (override: POOL_TVL_USD=...)`);
  console.log(`Pool fee (round-trip): ${(POOL_FEE_RATE * 100).toFixed(2)}%`);
  console.log(`Gas (round-trip):       $${GAS_COST.toFixed(2)}`);
  console.log('');

  console.log('Per-trade size = "per-side" capital. Total at-risk to operate one chain pair');
  console.log('= (per-side USDC + per-side WETH) × 2 chains = 4 × per-side (USD-denominated).');
  console.log('');

  const rows = CAPITAL_LEVELS.map((cap) => analyze(opps, cap));
  const header = ['per-side', 'breakeven', 'slip RT', 'trades fire', 'sum P&L', 'mean P&L', 'median P&L', 'P&L/day'];
  const widths = [10, 12, 9, 13, 12, 11, 12, 11];
  const headerLine = header.map((h, i) => h.padStart(widths[i])).join(' | ');
  console.log(headerLine);
  console.log('-'.repeat(headerLine.length));
  for (const r of rows) {
    const pnlPerDay = days > 0 ? r.sumPnl / days : 0;
    const row = [
      `$${r.capital.toLocaleString()}`,
      `${r.breakeven.toFixed(4)}%`,
      `${r.slippageRoundtripPct.toFixed(4)}%`,
      r.capturedCount.toLocaleString(),
      fmt$(r.sumPnl),
      fmt$(r.meanPnl),
      fmt$(r.medianPnl),
      fmt$(pnlPerDay),
    ];
    console.log(row.map((c, i) => c.padStart(widths[i])).join(' | '));
  }
  console.log('');

  console.log('Notes:');
  console.log(`  • "trades fire" = opps where net P&L > 0 at that capital level.`);
  console.log(`  • "P&L/day" = sumPnl / window days. Extrapolation; real markets vary.`);
  console.log(`  • Real slippage depends on per-pool TVL — try POOL_TVL_USD=10000000 (pessimistic) or 50000000 (optimistic).`);
  console.log(`  • Per-side capital column means inventory pre-positioned on EACH chain in a pair.`);
  console.log(`  • One opp = one round-trip = up to one trade. Doesn't double-count.`);
  console.log(`  • Doesn't model inventory drift (engine pauses one direction when depleted).`);
}

main();
