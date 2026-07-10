import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const LOG_FILE = process.env.LOG_FILE || join(homedir(), 'paxiom', 'opportunities.log');

// Fee mode — see sdk/price-feeder.js for the full three-mode rationale.
// Override with PAXIOM_FEE_MODE=solo|customer|aave-benchmark
const AAVE_BENCHMARK_FEE  = 0.0005;
const PAXIOM_CUSTOMER_FEE = 0.0009;
const OWN_COST_FEE        = 0;
const FEE_MODE = (process.env.PAXIOM_FEE_MODE || 'solo').toLowerCase();
const ACTIVE_FEE = FEE_MODE === 'customer'       ? PAXIOM_CUSTOMER_FEE
                 : FEE_MODE === 'aave-benchmark' ? AAVE_BENCHMARK_FEE
                 : OWN_COST_FEE;
const FLASH_FEE = ACTIVE_FEE;
const GAS_COST = 50;
const CAPITAL = 5_000_000;

const CAPTURABLE_PCT = { wstETH: 0.035, default: 0.05 };
const thresholdFor = (asset) => CAPTURABLE_PCT[asset] ?? CAPTURABLE_PCT.default;

const RESET = '\x1b[0m', BOLD = '\x1b[1m', DIM = '\x1b[2m';
const RED = '\x1b[31m', GREEN = '\x1b[32m', YELLOW = '\x1b[33m', CYAN = '\x1b[36m';

function synthesizeProfit(spreadPct) {
  return CAPITAL * (spreadPct / 100) - CAPITAL * ACTIVE_FEE - GAS_COST;
}

function loadRows(path) {
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  const rows = [];
  let parseErrors = 0;
  for (const line of lines) {
    try { rows.push(JSON.parse(line)); } catch { parseErrors++; }
  }
  return { rows, parseErrors };
}

function classify(row) {
  const spread = parseFloat(row.spreadPct);
  const asset = row.asset;
  const meetsThreshold = Number.isFinite(spread) && spread >= thresholdFor(asset);

  let pnl, pnlSource;
  if (row.realNetProfit !== undefined && !row.quoteFailed) {
    // The on-chain quoter netted out the *Aave-benchmark* flash fee (0.05%) inside
    // realNetProfit. Convert to the active mode by adding back the benchmark and
    // subtracting the active fee.
    pnl = parseFloat(row.realNetProfit);
    const usdcIn = parseFloat(row.usdcIn ?? CAPITAL);
    pnl += usdcIn * AAVE_BENCHMARK_FEE;
    pnl -= usdcIn * ACTIVE_FEE;
    pnlSource = 'real-quote';
  } else {
    pnl = synthesizeProfit(spread);
    pnlSource = 'synthetic';
  }

  return { spread, pnl, pnlSource, meetsThreshold, fieldCapturable: row.capturable === true };
}

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function aggregate(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const c = classify(row);
    if (!c.meetsThreshold) continue;
    const key = keyFn(row);
    const g = groups.get(key) || {
      key, count: 0, pnlSum: 0, pnlPositive: 0,
      spreads: [], pnls: [],
      fieldCapturableCount: 0, realQuoteCount: 0,
    };
    g.count++;
    g.pnlSum += c.pnl;
    if (c.pnl > 0) g.pnlPositive++;
    g.spreads.push(c.spread);
    g.pnls.push(c.pnl);
    if (c.fieldCapturable) g.fieldCapturableCount++;
    if (c.pnlSource === 'real-quote') g.realQuoteCount++;
    groups.set(key, g);
  }
  return [...groups.values()]
    .map(g => ({
      key: g.key,
      count: g.count,
      pnlSum: g.pnlSum,
      pnlMean: g.pnlSum / g.count,
      pnlMedian: median(g.pnls),
      spreadMean: g.spreads.reduce((a, b) => a + b, 0) / g.count,
      spreadMedian: median(g.spreads),
      hitRate: g.pnlPositive / g.count,
      realQuoteShare: g.realQuoteCount / g.count,
      fieldCapturableShare: g.fieldCapturableCount / g.count,
    }))
    .sort((a, b) => b.pnlSum - a.pnlSum);
}

function fmtMoney(n) {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(2)}k`;
  return `${sign}$${abs.toFixed(2)}`;
}

function colorMoney(n) {
  return (n >= 0 ? GREEN : RED) + fmtMoney(n) + RESET;
}

function pct(n, digits = 1) { return `${(n * 100).toFixed(digits)}%`; }

function printTable(title, groups, keyHeader, keyWidth = 28) {
  console.log(`\n${BOLD}${CYAN}=== ${title} ===${RESET}`);
  const header = [
    keyHeader.padEnd(keyWidth),
    'count'.padStart(6),
    'sum P&L'.padStart(12),
    'mean P&L'.padStart(12),
    'median P&L'.padStart(12),
    'mean sprd%'.padStart(11),
    'hit rate'.padStart(9),
    'real-quote'.padStart(11),
  ].join(' ');
  console.log(BOLD + header + RESET);
  console.log(DIM + '-'.repeat(header.length) + RESET);
  for (const g of groups) {
    console.log([
      String(g.key).padEnd(keyWidth),
      String(g.count).padStart(6),
      colorMoney(g.pnlSum).padStart(12 + (GREEN.length + RESET.length)),
      colorMoney(g.pnlMean).padStart(12 + (GREEN.length + RESET.length)),
      colorMoney(g.pnlMedian).padStart(12 + (GREEN.length + RESET.length)),
      g.spreadMean.toFixed(4).padStart(11),
      pct(g.hitRate).padStart(9),
      pct(g.realQuoteShare).padStart(11),
    ].join(' '));
  }
}

function main() {
  const { rows, parseErrors } = loadRows(LOG_FILE);
  console.log(`${DIM}Loaded ${rows.length} rows from ${LOG_FILE}${parseErrors ? ` (${parseErrors} parse errors)` : ''}${RESET}`);
  const feeNote = FEE_MODE === 'solo'           ? 'gas-only (sole LP+user)'
                : FEE_MODE === 'customer'       ? `${(ACTIVE_FEE * 100).toFixed(3)}% Paxiom customer fee paid`
                : FEE_MODE === 'aave-benchmark' ? `${(ACTIVE_FEE * 100).toFixed(3)}% Aave-benchmark fee`
                : `${(ACTIVE_FEE * 100).toFixed(3)}%`;
  console.log(`${DIM}Capital model: $${(CAPITAL / 1_000_000).toFixed(0)}M flash loan, ${feeNote}, $${GAS_COST} gas. Mode=${FEE_MODE}.${RESET}`);
  console.log(`${DIM}Capturable threshold: 0.05% default, 0.035% wstETH.${RESET}`);

  let total = 0, capturableCount = 0;
  for (const row of rows) {
    const c = classify(row);
    if (c.meetsThreshold) { total += c.pnl; capturableCount++; }
  }
  console.log(`\n${BOLD}Capturable rows: ${capturableCount} / ${rows.length}${RESET}`);
  console.log(`${BOLD}Total capturable P&L: ${colorMoney(total)}${RESET}`);

  printTable('By asset', aggregate(rows, r => r.asset), 'asset', 14);
  printTable('By chain pair (buy → sell)', aggregate(rows, r => `${r.buyChain} → ${r.sellChain}`), 'chain pair', 28);
  printTable('By DEX pair (buy → sell)', aggregate(rows, r => `${r.buyDex} → ${r.sellDex}`), 'dex pair', 24);

  console.log(`\n${DIM}Notes:${RESET}`);
  console.log(`${DIM}  • spreadPct is in percent (0.05 = 0.05% = 5 bps).${RESET}`);
  console.log(`${DIM}  • Hit rate = % of capturable rows with positive net P&L at $${(CAPITAL / 1_000_000).toFixed(0)}M capital.${RESET}`);
  console.log(`${DIM}  • Real-quote share = % of rows where on-chain quoter ran (later log entries only).${RESET}`);
}

main();
