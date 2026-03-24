import { readFileSync } from 'fs';

const LOG_FILE = '/home/mk19/paxiom/opportunities.log';
const CAPITAL = 5000;      // your deployed capital per side
const GAS_COST = 0.50;     // estimated gas per trade in USD

function clearScreen() {
  process.stdout.write('\x1Bc');
}

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const MAGENTA = '\x1b[35m';
const DIM = '\x1b[2m';

function timeSince(timestamp) {
  const seconds = Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds/60)}m ago`;
  return `${Math.floor(seconds/3600)}h ago`;
}

function calcProfit(spreadPct, capital) {
  const gross = capital * (parseFloat(spreadPct) / 100);
  return gross - GAS_COST;
}

function getColor(profit) {
  if (profit >= 10) return GREEN;
  if (profit >= 1) return YELLOW;
  return DIM;
}

function reconstructVelocity(lines) {
  const sorted = [...lines].sort((a, b) =>
    new Date(a.timestamp) - new Date(b.timestamp)
  );
  const history = {};
  for (let i = 0; i < sorted.length; i++) {
    const opp = sorted[i];
    const asset = opp.asset;
    const spread = parseFloat(opp.spreadPct);
    const ts = new Date(opp.timestamp).getTime();
    if (!history[asset]) history[asset] = [];
    history[asset].push({ spread, buy: opp.buyChain, sell: opp.sellChain, ts });
    const h = history[asset];
    if (h.length < 3) {
      sorted[i].recon_capturable = false;
      sorted[i].recon_velocity = 'unknown';
      continue;
    }
    const recent = h.slice(-3);
    const delta = recent[2].spread - recent[0].spread;
    const timeDelta = (recent[2].ts - recent[0].ts) / 1000;
    if (timeDelta === 0) {
      sorted[i].recon_capturable = false;
      sorted[i].recon_velocity = 'STABLE';
      continue;
    }
    const sameDir = recent.every(r => r.buy === recent[0].buy);
    const opening = delta > 0;
    sorted[i].recon_velocity = opening ? 'OPENING' : delta < 0 ? 'CLOSING' : 'STABLE';
    sorted[i].recon_capturable = sameDir && opening && spread > 0.005;
  }
  return sorted;
}

function isCapturable(opp) {
  if (opp.capturable !== undefined) return opp.capturable;
  return opp.recon_capturable || false;
}

function getVelocity(opp) {
  if (opp.velocity && opp.velocity !== 'unknown') return opp.velocity;
  return opp.recon_velocity || 'unknown';
}

function render() {
  clearScreen();

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  console.log(`${BOLD}${MAGENTA}╔════════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}${MAGENTA}║              PAXIOM CAPITAL DEPLOYMENT FEED                ║${RESET}`);
  console.log(`${BOLD}${MAGENTA}║         No Flash Loan Fee  │  Own Capital Model            ║${RESET}`);
  console.log(`${BOLD}${MAGENTA}║                   ${now} UTC                ║${RESET}`);
  console.log(`${BOLD}${MAGENTA}╚════════════════════════════════════════════════════════════╝${RESET}`);
  console.log('');

  try {
    const content = readFileSync(LOG_FILE, 'utf8');
    const raw = content.trim().split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
    const lines = reconstructVelocity(raw);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayOpps = lines.filter(o => new Date(o.timestamp) >= today);

    // Capital model profit calculations
    const profitable = todayOpps.filter(o => calcProfit(o.spreadPct, CAPITAL) > 0);
    const capturable = todayOpps.filter(o => isCapturable(o) && calcProfit(o.spreadPct, CAPITAL) > 0);
    const totalProfit = profitable.reduce((sum, o) => sum + calcProfit(o.spreadPct, CAPITAL), 0);
    const capturableProfit = capturable.reduce((sum, o) => sum + calcProfit(o.spreadPct, CAPITAL), 0);
    const spreads = todayOpps.map(o => parseFloat(o.spreadPct));
    const maxSpread = spreads.length ? Math.max(...spreads) : 0;
    const roi = (totalProfit / CAPITAL) * 100;
    const annualRoi = roi * 365;

    // Capital size comparison
    const capitals = [1000, 5000, 10000, 50000, 100000];

    console.log(`${BOLD}CAPITAL MODEL STATS — $${CAPITAL.toLocaleString()} deployed per side${RESET}`);
    console.log(`${DIM}${'─'.repeat(62)}${RESET}`);
    console.log(`  Total opportunities:      ${BOLD}${todayOpps.length}${RESET}`);
    console.log(`  Profitable (no fee):      ${BOLD}${GREEN}${profitable.length}${RESET}  ${DIM}vs ~5 with flash loan fee${RESET}`);
    console.log(`  Capturable & profitable:  ${BOLD}${GREEN}${capturable.length}${RESET}`);
    console.log(`  Total profit today:       ${BOLD}${GREEN}$${totalProfit.toFixed(2)}${RESET}`);
    console.log(`  Capturable profit today:  ${BOLD}${GREEN}$${capturableProfit.toFixed(2)}${RESET}`);
    console.log(`  Best spread:              ${BOLD}${GREEN}${maxSpread.toFixed(4)}%${RESET}`);
    console.log(`  Daily ROI:                ${BOLD}${GREEN}${roi.toFixed(3)}%${RESET}`);
    console.log(`  Projected annual ROI:     ${BOLD}${GREEN}${annualRoi.toFixed(1)}%${RESET}`);
    console.log('');

    // Capital scaling table
    console.log(`${BOLD}PROFIT SCALING BY CAPITAL SIZE${RESET}`);
    console.log(`${DIM}${'─'.repeat(62)}${RESET}`);
    console.log(`${DIM}  Capital      Today's Profit   Monthly Est.   Annual Est.${RESET}`);
    console.log(`${DIM}${'─'.repeat(62)}${RESET}`);
    for (const cap of capitals) {
      const dayProfit = profitable.reduce((sum, o) => sum + calcProfit(o.spreadPct, cap), 0);
      const monthly = dayProfit * 30;
      const annual = dayProfit * 365;
      const highlight = cap === CAPITAL ? BOLD : '';
      const marker = cap === CAPITAL ? ` ← current` : '';
      console.log(`  ${highlight}$${cap.toLocaleString().padEnd(10)}   $${dayProfit.toFixed(2).padEnd(14)}   $${monthly.toFixed(0).padEnd(12)}   $${annual.toFixed(0)}${RESET}${DIM}${marker}${RESET}`);
    }
    console.log('');

    // Best opportunities today capital model
    const sortedByProfit = [...todayOpps]
      .map(o => ({ ...o, profit: calcProfit(o.spreadPct, CAPITAL) }))
      .filter(o => o.profit > 0)
      .sort((a, b) => b.profit - a.profit)
      .slice(0, 5);

    console.log(`${BOLD}BEST OPPORTUNITIES TODAY (CAPITAL MODEL)${RESET}`);
    console.log(`${DIM}${'─'.repeat(62)}${RESET}`);
    console.log(`${DIM}  Time     Spread    Route              Profit    Vel${RESET}`);
    console.log(`${DIM}${'─'.repeat(62)}${RESET}`);
    for (const o of sortedByProfit) {
      const spread = parseFloat(o.spreadPct);
      const time = o.timestamp.slice(11, 19);
      const route = `${o.buyChain.slice(0, 4)} → ${o.sellChain.slice(0, 4)}`;
      const profit = o.profit;
      const color = getColor(profit);
      const cap = isCapturable(o) ? `${GREEN}●${RESET}` : `${DIM}○${RESET}`;
      const vel = getVelocity(o);
      const velStr = vel === 'OPENING' ? `${GREEN}↑${RESET}` :
                     vel === 'CLOSING' ? `${RED}↓${RESET}` : `${DIM}→${RESET}`;
      console.log(`  ${cap} ${time}  ${color}${spread.toFixed(4)}%${RESET}   ${o.asset.padEnd(6)} ${route.padEnd(14)} ${color}$${profit.toFixed(2).padEnd(8)}${RESET} ${velStr}`);
    }
    console.log('');

    // Recent activity
    const recent = [...lines].slice(-8).reverse();
    console.log(`${BOLD}RECENT ACTIVITY${RESET}`);
    console.log(`${DIM}${'─'.repeat(62)}${RESET}`);
    console.log(`${DIM}  Age      Spread    Route              Profit    Vel${RESET}`);
    console.log(`${DIM}${'─'.repeat(62)}${RESET}`);
    for (const o of recent) {
      const spread = parseFloat(o.spreadPct);
      const profit = calcProfit(o.spreadPct, CAPITAL);
      const age = timeSince(o.timestamp);
      const route = `${o.buyChain.slice(0, 4)} → ${o.sellChain.slice(0, 4)}`;
      const color = getColor(profit);
      const cap = isCapturable(o) ? `${GREEN}●${RESET}` : `${DIM}○${RESET}`;
      const vel = getVelocity(o);
      const velStr = vel === 'OPENING' ? `${GREEN}↑ OPENING${RESET}` :
                     vel === 'CLOSING' ? `${RED}↓ CLOSING${RESET}` :
                     `${DIM}→ STABLE${RESET}`;
      console.log(`  ${cap} ${age.padEnd(8)} ${color}${spread.toFixed(4)}%${RESET}   ${o.asset.padEnd(6)} ${route.padEnd(14)} ${color}$${profit.toFixed(2).padEnd(8)}${RESET} ${velStr}`);
    }
    console.log('');

    // Route breakdown
    const routeStats = {};
    for (const o of profitable) {
      const key = `${o.buyChain} → ${o.sellChain}`;
      if (!routeStats[key]) routeStats[key] = { count: 0, profit: 0, capturable: 0 };
      routeStats[key].count++;
      routeStats[key].profit += calcProfit(o.spreadPct, CAPITAL);
      if (isCapturable(o)) routeStats[key].capturable++;
    }

    const routeSorted = Object.entries(routeStats)
      .sort((a, b) => b[1].profit - a[1].profit)
      .slice(0, 5);

    console.log(`${BOLD}BEST ROUTES TODAY (by profit)${RESET}`);
    console.log(`${DIM}${'─'.replace(/x/g, '─').padEnd(1)}${'─'.repeat(61)}${RESET}`);
    for (const [route, stats] of routeSorted) {
      console.log(`  ${route.padEnd(25)} ${stats.count} trades   ${GREEN}$${stats.profit.toFixed(2).padEnd(10)}${RESET} capturable: ${GREEN}${stats.capturable}${RESET}`);
    }

    console.log('');
    console.log(`${DIM}● capturable  ○ not capturable  │  gas: $${GAS_COST}/trade  │  refreshing 5s${RESET}`);
    console.log(`${DIM}Capital model: no flash loan fee. Profit = spread × capital - gas${RESET}`);

  } catch(e) {
    console.log(`${RED}Error: ${e.message}${RESET}`);
  }
}

render();
setInterval(render, 5000);
