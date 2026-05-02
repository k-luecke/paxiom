import { readFileSync } from 'fs';

const LOG_FILE = '/home/mk19/paxiom/opportunities.log';

function clearScreen() {
  process.stdout.write('\x1Bc');
}

function getColor(spread) {
  if (spread >= 0.1) return '\x1b[32m';
  if (spread >= 0.05) return '\x1b[33m';
  return '\x1b[37m';
}

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';


function formatProfit(spread, loan) {
  const profit = loan * (parseFloat(spread) / 100) - 50;
  if (profit <= 0) return `${RED}loss${RESET}`;
  return `${GREEN}$${profit.toFixed(0)}${RESET}`;
}

function timeSince(timestamp) {
  const seconds = Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds/60)}m ago`;
  return `${Math.floor(seconds/3600)}h ago`;
}

function reconstructVelocity(lines) {
  // Sort by time first
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
      sorted[i].recon_velocity = 'unknown';
      sorted[i].recon_capturable = false;
      continue;
    }

    const recent = h.slice(-3);
    const delta = recent[2].spread - recent[0].spread;
    const timeDelta = (recent[2].ts - recent[0].ts) / 1000;

    if (timeDelta === 0) {
      sorted[i].recon_velocity = 'STABLE';
      sorted[i].recon_capturable = false;
      continue;
    }

    const sameDir = recent.every(r => r.buy === recent[0].buy);
    const opening = delta > 0;
    const rate = delta / timeDelta;

    sorted[i].recon_velocity = opening ? 'OPENING' : delta < 0 ? 'CLOSING' : 'STABLE';
    sorted[i].recon_capturable = sameDir && opening && spread > 0.05;
    sorted[i].recon_rate = rate;
  }

  return sorted;
}

function isCapturable(opp) {
  // Use real velocity if available, reconstructed if not
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

  console.log(`${BOLD}${CYAN}╔════════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}${CYAN}║                   PAXIOM OPPORTUNITY FEED                  ║${RESET}`);
  console.log(`${BOLD}${CYAN}║                   ${now} UTC                ║${RESET}`);
  console.log(`${BOLD}${CYAN}╚════════════════════════════════════════════════════════════╝${RESET}`);
  console.log('');

  try {
    const content = readFileSync(LOG_FILE, 'utf8');
    const raw = content.trim().split('\n').filter(l => l.trim()).map(l => JSON.parse(l));

    // Reconstruct velocity for all entries
    const lines = reconstructVelocity(raw);

    // Today only
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayOpps = lines.filter(o => new Date(o.timestamp) >= today);

    // Stats
    const spreads = todayOpps.map(o => parseFloat(o.spreadPct));
    const maxSpread = spreads.length ? Math.max(...spreads) : 0;
    const avgSpread = spreads.length ? spreads.reduce((a, b) => a + b, 0) / spreads.length : 0;
    const above01 = spreads.filter(s => s >= 0.1).length;
    const capturable = todayOpps.filter(o => isCapturable(o)).length;
    const capturableProfit5m = todayOpps
      .filter(o => isCapturable(o))
      .reduce((sum, o) => sum + (5000000 * (parseFloat(o.spreadPct)/100) - 50), 0);

    console.log(`${BOLD}TODAY'S STATS${RESET}`);
    console.log(`${DIM}${'─'.repeat(62)}${RESET}`);
    console.log(`  Total opportunities:  ${BOLD}${todayOpps.length}${RESET}`);
    console.log(`  Average spread:       ${BOLD}${avgSpread.toFixed(4)}%${RESET}`);
    console.log(`  Best spread:          ${BOLD}${GREEN}${maxSpread.toFixed(4)}%${RESET}`);
    console.log(`  Above 0.1%:           ${BOLD}${YELLOW}${above01}${RESET}`);
    console.log(`  Capturable events:    ${BOLD}${GREEN}${capturable}${RESET}`);
    console.log(`  Capturable $5M total: ${BOLD}${GREEN}$${capturableProfit5m.toFixed(0)}${RESET}`);
    console.log('');

    // Best opportunities with reconstructed capturable
    const sorted = [...todayOpps].sort((a, b) => parseFloat(b.spreadPct) - parseFloat(a.spreadPct));
    const top = sorted.slice(0, 5);

    console.log(`${BOLD}BEST OPPORTUNITIES TODAY${RESET}`);
    console.log(`${DIM}${'─'.repeat(62)}${RESET}`);
    console.log(`${DIM}  Time     Spread   Route                Vel        $1M      $5M${RESET}`);
    console.log(`${DIM}${'─'.repeat(62)}${RESET}`);

    for (const o of top) {
      const spread = parseFloat(o.spreadPct);
      const color = getColor(spread);
      const time = o.timestamp.slice(11, 19);
      const route = `${o.buyChain.slice(0, 4)} → ${o.sellChain.slice(0, 4)}`;
      const p1m = formatProfit(o.spreadPct, 1000000);
      const p5m = formatProfit(o.spreadPct, 5000000);
      const cap = isCapturable(o) ? `${GREEN}●${RESET}` : `${DIM}○${RESET}`;
      const vel = getVelocity(o);
      const velStr = vel === 'OPENING' ? `${GREEN}↑${RESET}` :
                     vel === 'CLOSING' ? `${RED}↓${RESET}` :
                     vel === 'STABLE' ? `→` : `${DIM}?${RESET}`;
      console.log(`  ${cap} ${time}  ${color}${spread.toFixed(4)}%${RESET}   ${o.asset.padEnd(6)} ${route.padEnd(12)} ${velStr}          ${p1m.padEnd(12)} ${p5m}`);
    }

    console.log('');

    // Recent activity
    const recent = [...lines].slice(-10).reverse();

    console.log(`${BOLD}RECENT ACTIVITY${RESET}`);
    console.log(`${DIM}${'─'.repeat(62)}${RESET}`);
    console.log(`${DIM}  Age      Spread   Route                Velocity${RESET}`);
    console.log(`${DIM}${'─'.repeat(62)}${RESET}`);

    for (const o of recent) {
      const spread = parseFloat(o.spreadPct);
      const color = getColor(spread);
      const age = timeSince(o.timestamp);
      const route = `${o.buyChain.slice(0, 4)} → ${o.sellChain.slice(0, 4)}`;
      const vel = getVelocity(o);
      const velStr = vel === 'OPENING' ? `${GREEN}↑ OPENING${RESET}` :
                     vel === 'CLOSING' ? `${RED}↓ CLOSING${RESET}` :
                     vel === 'STABLE' ? `${DIM}→ STABLE${RESET}` : `${DIM}? unknown${RESET}`;
      const cap = isCapturable(o) ? `${GREEN}●${RESET}` : `${DIM}○${RESET}`;
      console.log(`  ${cap} ${age.padEnd(8)} ${color}${spread.toFixed(4)}%${RESET}   ${o.asset.padEnd(6)} ${route.padEnd(12)} ${velStr}`);
    }

    console.log('');

    // Best routes
    const chainStats = {};
    for (const o of todayOpps) {
      const key = `${o.buyChain} → ${o.sellChain}`;
      if (!chainStats[key]) chainStats[key] = { count: 0, totalSpread: 0, capturable: 0 };
      chainStats[key].count++;
      chainStats[key].totalSpread += parseFloat(o.spreadPct);
      if (isCapturable(o)) chainStats[key].capturable++;
    }

    const chainSorted = Object.entries(chainStats)
      .sort((a, b) => b[1].totalSpread - a[1].totalSpread)
      .slice(0, 5);

    console.log(`${BOLD}BEST ROUTES TODAY${RESET}`);
    console.log(`${DIM}${'─'.repeat(62)}${RESET}`);
    for (const [route, stats] of chainSorted) {
      const avg = (stats.totalSpread / stats.count).toFixed(4);
      console.log(`  ${route.padEnd(25)} ${stats.count} events   avg ${YELLOW}${avg}%${RESET}   capturable: ${GREEN}${stats.capturable}${RESET}`);
    }

    console.log('');
    console.log(`${DIM}● capturable  ○ not capturable  │  refreshing every 5s${RESET}`);

  } catch(e) {
    console.log(`${RED}Error: ${e.message}${RESET}`);
  }
}

render();
setInterval(render, 5000);
