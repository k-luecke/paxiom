import { readFileSync } from 'fs';

const LOG_FILE = '/home/mk19/paxiom/opportunities.log';

function clearScreen() { process.stdout.write('\x1Bc'); }

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';

function timeSince(timestamp) {
  const s = Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  return `${Math.floor(s/86400)}d ago`;
}

function render() {
  clearScreen();
  const now = new Date().toISOString().replace('T',' ').slice(0,19);

  console.log(`${BOLD}${CYAN}╔════════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}${CYAN}║              PAXIOM — ALL-TIME OPPORTUNITY TRACKER         ║${RESET}`);
  console.log(`${BOLD}${CYAN}║                   ${now} UTC                ║${RESET}`);
  console.log(`${BOLD}${CYAN}╚════════════════════════════════════════════════════════════╝${RESET}`);
  console.log('');

  try {
    const content = readFileSync(LOG_FILE, 'utf8');
    const lines = content.trim().split('\n').filter(l => l.trim());
    const all = lines.map(l => JSON.parse(l));

    if (all.length === 0) {
      console.log(`No data yet.`);
      return;
    }

    const timestamps = all.map(o => new Date(o.timestamp).getTime());
    const first = new Date(Math.min(...timestamps));
    const last  = new Date(Math.max(...timestamps));
    const daysDiff = (last - first) / (1000 * 60 * 60 * 24) || 1;

    const spreads = all.map(o => parseFloat(o.spreadPct));
    const avg    = spreads.reduce((a,b) => a+b,0) / spreads.length;
    const max    = Math.max(...spreads);
    const min    = Math.min(...spreads);
    const above01 = spreads.filter(s => s >= 0.1).length;
    const above05 = spreads.filter(s => s >= 0.05).length;
    const perDay  = all.length / daysDiff;

    const best = all.reduce((a,b) => parseFloat(a.spreadPct) > parseFloat(b.spreadPct) ? a : b);

    const assetStats = {};
    for (const o of all) {
      if (!assetStats[o.asset]) assetStats[o.asset] = { count: 0, total: 0, max: 0 };
      const s = parseFloat(o.spreadPct);
      assetStats[o.asset].count++;
      assetStats[o.asset].total += s;
      if (s > assetStats[o.asset].max) assetStats[o.asset].max = s;
    }

    const routeStats = {};
    for (const o of all) {
      const key = `${o.buyChain} → ${o.sellChain}`;
      if (!routeStats[key]) routeStats[key] = { count: 0, total: 0, max: 0 };
      const s = parseFloat(o.spreadPct);
      routeStats[key].count++;
      routeStats[key].total += s;
      if (s > routeStats[key].max) routeStats[key].max = s;
    }

    const byDay = {};
    for (const o of all) {
      const day = o.timestamp.slice(0,10);
      if (!byDay[day]) byDay[day] = { count: 0, max: 0, above01: 0 };
      const s = parseFloat(o.spreadPct);
      byDay[day].count++;
      if (s > byDay[day].max) byDay[day].max = s;
      if (s >= 0.1) byDay[day].above01++;
    }

    // ─── OVERALL STATS ───────────────────────────────────────────
    console.log(`${BOLD}ALL-TIME STATS${RESET}`);
    console.log(`${DIM}${'─'.repeat(62)}${RESET}`);
    console.log(`  Total opportunities:     ${BOLD}${GREEN}${all.length.toLocaleString()}${RESET}`);
    console.log(`  Tracking since:          ${BOLD}${first.toISOString().slice(0,10)}${RESET}  ${DIM}(${daysDiff.toFixed(1)} days)${RESET}`);
    console.log(`  Average per day:         ${BOLD}${perDay.toFixed(0)}${RESET}`);
    console.log(`  Average spread:          ${BOLD}${CYAN}${avg.toFixed(4)}%${RESET}`);
    console.log(`  Min spread logged:       ${DIM}${min.toFixed(4)}%${RESET}`);
    console.log(`  Max spread ever:         ${BOLD}${GREEN}${max.toFixed(4)}%${RESET}`);
    console.log(`  Above 0.05%:             ${BOLD}${YELLOW}${above05.toLocaleString()}${RESET}  ${DIM}(${(above05/all.length*100).toFixed(1)}%)${RESET}`);
    console.log(`  Above 0.10%:             ${BOLD}${GREEN}${above01.toLocaleString()}${RESET}  ${DIM}(${(above01/all.length*100).toFixed(1)}%)${RESET}`);
    console.log(`  Last entry:              ${DIM}${timeSince(last.toISOString())}${RESET}`);
    console.log('');

    // ─── BEST EVENT EVER ─────────────────────────────────────────
    console.log(`${BOLD}BEST OPPORTUNITY EVER RECORDED${RESET}`);
    console.log(`${DIM}${'─'.repeat(62)}${RESET}`);
    console.log(`  Date:     ${best.timestamp.slice(0,19).replace('T',' ')} UTC`);
    console.log(`  Asset:    ${BOLD}${best.asset}${RESET}`);
    console.log(`  Spread:   ${BOLD}${GREEN}${best.spreadPct}%${RESET}`);
    console.log(`  Route:    ${best.buyChain} -> ${best.sellChain}`);
    const p1m  = 1000000  * (parseFloat(best.spreadPct)/100) - 0.50;
    const p5m  = 5000000  * (parseFloat(best.spreadPct)/100) - 0.50;
    const p10m = 10000000 * (parseFloat(best.spreadPct)/100) - 0.50;
    console.log(`  $1M: ${GREEN}$${p1m.toFixed(0)}${RESET}  |  $5M: ${GREEN}$${p5m.toFixed(0)}${RESET}  |  $10M: ${GREEN}$${p10m.toFixed(0)}${RESET}`);
    console.log('');

    // ─── CAPITAL MODEL PROFIT ────────────────────────────────────
    console.log(`${BOLD}TOTAL PROFIT ESTIMATES — CAPITAL MODEL (46% capture rate)${RESET}`);
    console.log(`${DIM}${'─'.repeat(62)}${RESET}`);
    console.log(`${DIM}  Capital      Raw all-time     Realistic        Daily avg${RESET}`);
    console.log(`${DIM}${'─'.repeat(62)}${RESET}`);
    const GAS = 0.50;
    const CAPTURE = 0.46;
    for (const cap of [5000, 10000, 50000, 100000]) {
      const raw = all.reduce((sum, o) => {
        const p = cap * (parseFloat(o.spreadPct)/100) - GAS;
        return p > 0 ? sum + p : sum;
      }, 0);
      const realistic = raw * CAPTURE;
      const daily = realistic / daysDiff;
      console.log(`  $${cap.toLocaleString().padEnd(10)} $${raw.toFixed(2).padEnd(16)} $${realistic.toFixed(2).padEnd(16)} $${daily.toFixed(2)}/day`);
    }
    console.log('');

    // ─── FLASH LOAN ELIGIBLE ─────────────────────────────────────
    console.log(`${BOLD}FLASH LOAN ELIGIBLE EVENTS (spread > 0.09%)${RESET}`);
    console.log(`${DIM}${'─'.repeat(62)}${RESET}`);
    const flash = all.filter(o => parseFloat(o.spreadPct) > 0.09);
    const fl1m = flash.reduce((s,o) => s + (1000000*(parseFloat(o.spreadPct)/100) - 900 - 50), 0);
    const fl5m = flash.reduce((s,o) => s + (5000000*(parseFloat(o.spreadPct)/100) - 4500 - 50), 0);
    console.log(`  Eligible events:     ${BOLD}${GREEN}${flash.length}${RESET}  ${DIM}of ${all.length} total (${(flash.length/all.length*100).toFixed(1)}%)${RESET}`);
    console.log(`  All-time $1M profit: ${GREEN}$${fl1m.toFixed(2)}${RESET}`);
    console.log(`  All-time $5M profit: ${GREEN}$${fl5m.toFixed(2)}${RESET}`);
    console.log('');

    // ─── PAXIOMPOOL FEE SIMULATION ───────────────────────────────
    console.log(`${BOLD}PAXIOMPOOL FEE SIMULATION (avg $5,000 loan per opportunity)${RESET}`);
    console.log(`${DIM}${'─'.repeat(62)}${RESET}`);
    const loanVol    = all.length * 5000;
    const protocolFee = loanVol * 0.0009 * 0.30;
    const lpFee       = loanVol * 0.0009 * 0.70;
    const dailyFee    = protocolFee / daysDiff;
    console.log(`  Simulated loan volume:   ${CYAN}$${loanVol.toLocaleString()}${RESET}`);
    console.log(`  Protocol fees (0.03%):   ${GREEN}$${protocolFee.toFixed(2)}${RESET}  ${DIM}($${dailyFee.toFixed(2)}/day)${RESET}`);
    console.log(`  LP fees (0.06%):         ${GREEN}$${lpFee.toFixed(2)}${RESET}`);
    console.log('');

    // ─── BY ASSET ────────────────────────────────────────────────
    console.log(`${BOLD}BY ASSET${RESET}`);
    console.log(`${DIM}${'─'.repeat(62)}${RESET}`);
    console.log(`${DIM}  Asset       Count    Avg spread    Max spread    % of total${RESET}`);
    console.log(`${DIM}${'─'.repeat(62)}${RESET}`);
    const assetSorted = Object.entries(assetStats).sort((a,b) => b[1].count - a[1].count);
    for (const [asset, s] of assetSorted) {
      const avg2 = (s.total / s.count).toFixed(4);
      const pct  = (s.count / all.length * 100).toFixed(1);
      console.log(`  ${asset.padEnd(12)}${s.count.toString().padEnd(9)}${avg2.padEnd(14)}${YELLOW}${s.max.toFixed(4)}%${RESET}      ${DIM}${pct}%${RESET}`);
    }
    console.log('');

    // ─── BY ROUTE ────────────────────────────────────────────────
    console.log(`${BOLD}BY ROUTE (top 6)${RESET}`);
    console.log(`${DIM}${'─'.repeat(62)}${RESET}`);
    console.log(`${DIM}  Route                      Count    Avg spread    Max${RESET}`);
    console.log(`${DIM}${'─'.repeat(62)}${RESET}`);
    const routeSorted = Object.entries(routeStats)
      .sort((a,b) => b[1].count - a[1].count).slice(0,6);
    for (const [route, s] of routeSorted) {
      const avg2 = (s.total / s.count).toFixed(4);
      console.log(`  ${route.padEnd(27)}${s.count.toString().padEnd(9)}${avg2.padEnd(14)}${YELLOW}${s.max.toFixed(4)}%${RESET}`);
    }
    console.log('');

    // ─── DAY BY DAY ──────────────────────────────────────────────
    console.log(`${BOLD}DAY BY DAY${RESET}`);
    console.log(`${DIM}${'─'.repeat(62)}${RESET}`);
    console.log(`${DIM}  Date         Opportunities    Best spread    Above 0.1%${RESET}`);
    console.log(`${DIM}${'─'.repeat(62)}${RESET}`);
    const daySorted = Object.entries(byDay).sort((a,b) => a[0].localeCompare(b[0]));
    for (const [day, s] of daySorted) {
      const maxColor = s.max >= 0.1 ? GREEN : s.max >= 0.05 ? YELLOW : DIM;
      console.log(`  ${day}     ${s.count.toString().padEnd(17)}${maxColor}${s.max.toFixed(4)}%${RESET}       ${s.above01 > 0 ? GREEN + s.above01 + RESET : DIM + '0' + RESET}`);
    }
    console.log('');
    console.log(`${DIM}Refreshing every 30 seconds${RESET}`);

  } catch(e) {
    console.log(`Error: ${e.message}`);
  }
}

render();
setInterval(render, 30000);
