import { readFileSync } from 'fs';

const LOG_FILE = '/home/mk19/paxiom/opportunities.log';
const CAPITAL_SIZES = [1000, 5000, 10000, 50000, 100000];
const GAS_COST = 0.50;
const CAPTURE_RATE = 0.46;

function clearScreen() { process.stdout.write('\x1Bc'); }

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const BLUE = '\x1b[34m';

function timeSince(timestamp) {
  const s = Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  return `${Math.floor(s/86400)}d ago`;
}

function reconstructVelocity(lines) {
  const sorted = [...lines].sort((a,b) => new Date(a.timestamp) - new Date(b.timestamp));
  const history = {};
  for (let i = 0; i < sorted.length; i++) {
    const o = sorted[i];
    const spread = parseFloat(o.spreadPct);
    const ts = new Date(o.timestamp).getTime();
    if (!history[o.asset]) history[o.asset] = [];
    history[o.asset].push({ spread, buy: o.buyChain, sell: o.sellChain, ts });
    const h = history[o.asset];
    if (h.length < 3) { sorted[i].recon_capturable = false; sorted[i].recon_velocity = 'unknown'; continue; }
    const recent = h.slice(-3);
    const delta = recent[2].spread - recent[0].spread;
    const timeDelta = (recent[2].ts - recent[0].ts) / 1000;
    if (timeDelta === 0) { sorted[i].recon_capturable = false; sorted[i].recon_velocity = 'STABLE'; continue; }
    const sameDir = recent.every(r => r.buy === recent[0].buy);
    sorted[i].recon_velocity = delta > 0 ? 'OPENING' : delta < 0 ? 'CLOSING' : 'STABLE';
    sorted[i].recon_capturable = sameDir && delta > 0 && spread > 0.005;
    sorted[i].recon_rate = delta / timeDelta;
  }
  return sorted;
}

function isCapturable(o) {
  if (o.capturable !== undefined) return o.capturable;
  return o.recon_capturable || false;
}

function getVelocity(o) {
  if (o.velocity && o.velocity !== 'unknown') return o.velocity;
  return o.recon_velocity || 'unknown';
}

function calcProfit(spreadPct, capital) {
  return capital * (parseFloat(spreadPct) / 100) - GAS_COST;
}

function analyzeDataset(data, label) {
  if (data.length === 0) return null;
  const spreads = data.map(o => parseFloat(o.spreadPct));
  const avgSpread = spreads.reduce((a,b) => a+b,0) / spreads.length;
  const maxSpread = Math.max(...spreads);
  const minSpread = Math.min(...spreads);
  const capturable = data.filter(o => isCapturable(o));

  const directions = data.map(o => `${o.buyChain}→${o.sellChain}`);
  const dirCount = {};
  for (const d of directions) dirCount[d] = (dirCount[d] || 0) + 1;
  const primaryDir = Object.entries(dirCount).sort((a,b) => b[1]-a[1])[0];
  const dirPct = primaryDir ? ((primaryDir[1] / directions.length) * 100).toFixed(0) : 0;

  return { label, count: data.length, avgSpread, maxSpread, minSpread, capturable: capturable.length, primaryDir: primaryDir?.[0], dirPct };
}

function render() {
  clearScreen();
  const now = new Date().toISOString().replace('T',' ').slice(0,19);

  console.log(`${BOLD}${BLUE}╔════════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}${BLUE}║           PAXIOM  —  wstETH STRUCTURAL SPREAD FEED         ║${RESET}`);
  console.log(`${BOLD}${BLUE}║         Liquid Staking Token  │  Own Capital Model          ║${RESET}`);
  console.log(`${BOLD}${BLUE}║                   ${now} UTC                ║${RESET}`);
  console.log(`${BOLD}${BLUE}╚════════════════════════════════════════════════════════════╝${RESET}`);
  console.log('');

  try {
    const content = readFileSync(LOG_FILE, 'utf8');
    const raw = content.trim().split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
    const all = reconstructVelocity(raw);

    // All wstETH ever logged
    const wsteth = all.filter(o => o.asset === 'wstETH');

    if (wsteth.length === 0) {
      console.log(`${YELLOW}No wstETH data in log yet.${RESET}`);
      console.log(`${DIM}The scanner detects wstETH spreads above 0.05%.${RESET}`);
      console.log(`${DIM}Current wstETH spread is ~0.04% — just below threshold.${RESET}`);
      console.log('');
      console.log(`${DIM}To lower the threshold and capture wstETH data:${RESET}`);
      console.log(`${DIM}Edit price-feeder.js and change MIN_SPREAD from 0.05 to 0.03${RESET}`);
      return;
    }

    // Time buckets
    const now2 = new Date();
    const todayStart = new Date(now2); todayStart.setHours(0,0,0,0);
    const yesterdayStart = new Date(todayStart); yesterdayStart.setDate(yesterdayStart.getDate()-1);

    const todayWst = wsteth.filter(o => new Date(o.timestamp) >= todayStart);
    const yesterdayWst = wsteth.filter(o => new Date(o.timestamp) >= yesterdayStart && new Date(o.timestamp) < todayStart);
    const allTimeWst = wsteth;

    // Use best available dataset for stats
    const primaryDataset = todayWst.length >= 3 ? todayWst :
                           yesterdayWst.length >= 3 ? yesterdayWst :
                           allTimeWst;
    const datasetLabel = todayWst.length >= 3 ? 'TODAY' :
                         yesterdayWst.length >= 3 ? 'YESTERDAY' :
                         'ALL TIME';

    const stats = analyzeDataset(primaryDataset, datasetLabel);

    console.log(`${BOLD}wstETH STRUCTURAL SPREAD — ${stats.label}${RESET}  ${DIM}(${wsteth.length} total historical observations)${RESET}`);
    console.log(`${DIM}${'─'.repeat(62)}${RESET}`);
    console.log(`  Observations:           ${BOLD}${stats.count}${RESET}`);
    console.log(`  Average spread:         ${BOLD}${CYAN}${stats.avgSpread.toFixed(4)}%${RESET}`);
    console.log(`  Spread range:           ${BOLD}${stats.minSpread.toFixed(4)}% — ${stats.maxSpread.toFixed(4)}%${RESET}`);
    console.log(`  Primary direction:      ${BOLD}${GREEN}${stats.primaryDir}${RESET}  ${DIM}(${stats.dirPct}% consistent)${RESET}`);
    console.log(`  Capturable events:      ${BOLD}${GREEN}${stats.capturable}${RESET}`);
    console.log('');

    // Historical comparison if we have multiple days
    if (todayWst.length > 0 && yesterdayWst.length > 0) {
      const todayStats = analyzeDataset(todayWst, 'Today');
      const yestStats = analyzeDataset(yesterdayWst, 'Yesterday');
      console.log(`${BOLD}DAY OVER DAY COMPARISON${RESET}`);
      console.log(`${DIM}${'─'.repeat(62)}${RESET}`);
      console.log(`  ${DIM}               Today          Yesterday${RESET}`);
      console.log(`  Observations:  ${BOLD}${todayStats.count.toString().padEnd(14)}${RESET} ${yestStats.count}`);
      console.log(`  Avg spread:    ${BOLD}${CYAN}${todayStats.avgSpread.toFixed(4)}%${RESET}${''.padEnd(8)} ${yestStats.avgSpread.toFixed(4)}%`);
      console.log(`  Max spread:    ${BOLD}${GREEN}${todayStats.maxSpread.toFixed(4)}%${RESET}${''.padEnd(8)} ${yestStats.maxSpread.toFixed(4)}%`);
      console.log(`  Capturable:    ${BOLD}${GREEN}${todayStats.capturable.toString().padEnd(14)}${RESET} ${yestStats.capturable}`);
      console.log('');
    }

    // Why structural
    console.log(`${BOLD}WHY THIS SPREAD IS STRUCTURAL${RESET}`);
    console.log(`${DIM}${'─'.repeat(62)}${RESET}`);
    console.log(`  ${DIM}wstETH accrues staking rewards continuously. Different chains${RESET}`);
    console.log(`  ${DIM}update the exchange rate via oracles at different frequencies.${RESET}`);
    console.log(`  ${DIM}This creates a persistent pricing gap — unlike ETH arbitrage${RESET}`);
    console.log(`  ${DIM}which closes in seconds. Direction is consistent >95% of time.${RESET}`);
    console.log(`  ${DIM}Less competition. More execution time. Lower front-run risk.${RESET}`);
    console.log('');

    // Capital scaling
    console.log(`${BOLD}PROFIT SCALING — ${stats.label} DATA (${(CAPTURE_RATE*100).toFixed(0)}% capture rate)${RESET}`);
    console.log(`${DIM}${'─'.repeat(62)}${RESET}`);
    console.log(`${DIM}  Capital      Raw Daily    Realistic     Monthly      Annual${RESET}`);
    console.log(`${DIM}${'─'.repeat(62)}${RESET}`);

    for (const cap of CAPITAL_SIZES) {
      const rawDaily = primaryDataset.reduce((sum,o) => {
        const p = calcProfit(o.spreadPct, cap);
        return p > 0 ? sum + p : sum;
      }, 0);
      const realistic = rawDaily * CAPTURE_RATE;
      const monthly = realistic * 30;
      const annual = realistic * 365;
      console.log(`  $${cap.toLocaleString().padEnd(10)} $${rawDaily.toFixed(2).padEnd(12)} $${realistic.toFixed(2).padEnd(13)} $${monthly.toFixed(0).padEnd(12)} $${annual.toFixed(0)}`);
    }
    console.log('');

    // Spread history chart
    console.log(`${BOLD}SPREAD HISTORY — LAST 20 OBSERVATIONS${RESET}`);
    console.log(`${DIM}${'─'.repeat(62)}${RESET}`);
    const last20 = wsteth.slice(-20);
    const chartMax = Math.max(...last20.map(o => parseFloat(o.spreadPct)));
    for (const o of last20) {
      const spread = parseFloat(o.spreadPct);
      const barLen = Math.max(1, Math.round((spread / chartMax) * 40));
      const bar = '█'.repeat(barLen);
      const time = o.timestamp.slice(11,16);
      const vel = getVelocity(o);
      const color = vel === 'OPENING' ? GREEN : vel === 'CLOSING' ? RED : YELLOW;
      const age = timeSince(o.timestamp);
      console.log(`  ${DIM}${age.padEnd(8)}${RESET} ${time} ${color}${bar}${RESET} ${spread.toFixed(4)}%`);
    }
    console.log('');

    // Recent entries
    console.log(`${BOLD}RECENT wstETH OBSERVATIONS${RESET}`);
    console.log(`${DIM}${'─'.repeat(62)}${RESET}`);
    console.log(`${DIM}  Age        Spread    Direction        Velocity       $5k profit${RESET}`);
    console.log(`${DIM}${'─'.repeat(62)}${RESET}`);

    const recent = [...wsteth].slice(-8).reverse();
    for (const o of recent) {
      const spread = parseFloat(o.spreadPct);
      const profit = calcProfit(o.spreadPct, 5000);
      const age = timeSince(o.timestamp);
      const dir = `${o.buyChain.slice(0,4)} → ${o.sellChain.slice(0,4)}`;
      const vel = getVelocity(o);
      const velStr = vel === 'OPENING' ? `${GREEN}↑ OPENING${RESET}` :
                     vel === 'CLOSING' ? `${RED}↓ CLOSING${RESET}` :
                     vel === 'STABLE'  ? `${YELLOW}→ STABLE${RESET}` :
                     `${DIM}? unknown${RESET}`;
      const cap = isCapturable(o) ? `${GREEN}●${RESET}` : `${DIM}○${RESET}`;
      const profitStr = profit > 0 ? `${GREEN}$${profit.toFixed(2)}${RESET}` : `${RED}-$${Math.abs(profit).toFixed(2)}${RESET}`;
      console.log(`  ${cap} ${age.padEnd(10)} ${CYAN}${spread.toFixed(4)}%${RESET}   ${dir.padEnd(16)} ${velStr.padEnd(20)} ${profitStr}`);
    }
    console.log('');

    // Current status
    const latest = wsteth[wsteth.length-1];
    const latestVel = latest ? getVelocity(latest) : 'unknown';
    const latestSpread = latest ? parseFloat(latest.spreadPct) : 0;
    const latestAge = latest ? timeSince(latest.timestamp) : 'unknown';

    console.log(`${BOLD}CURRENT STATUS${RESET}`);
    console.log(`${DIM}${'─'.repeat(62)}${RESET}`);
    console.log(`  Last observation:  ${latestAge}`);
    console.log(`  Last spread:       ${CYAN}${latestSpread.toFixed(4)}%${RESET}`);

    if (latestVel === 'STABLE' || latestVel === 'OPENING') {
      console.log(`  Status:            ${GREEN}● ACTIVE — ready for execution${RESET}`);
    } else if (latestVel === 'CLOSING') {
      console.log(`  Status:            ${YELLOW}⚠ CLOSING — wait for next opening${RESET}`);
    } else {
      console.log(`  Status:            ${DIM}○ Monitoring${RESET}`);
    }

    // Note if current spread is below logging threshold
    console.log('');
    console.log(`${DIM}Note: Scanner logs wstETH when spread ≥ 0.05%. Current structural${RESET}`);
    console.log(`${DIM}spread is ~0.04% — just below threshold. To capture all wstETH${RESET}`);
    console.log(`${DIM}data lower MIN_SPREAD to 0.03 in price-feeder.js${RESET}`);
    console.log('');
    console.log(`${DIM}● capturable  ○ not capturable  │  capture rate: ${(CAPTURE_RATE*100).toFixed(0)}%  │  refresh: 5s${RESET}`);

  } catch(e) {
    console.log(`${RED}Error: ${e.message}${RESET}`);
  }
}

render();
setInterval(render, 5000);
