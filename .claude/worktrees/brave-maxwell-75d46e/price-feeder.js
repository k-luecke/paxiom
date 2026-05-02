import { appendFileSync, readFileSync, writeFileSync } from 'fs';

const PROCESS_ID = 'w_MR7QlkfuRcfd3TQJPD1pzMwU5yEEyLMDjO0Ql8_5I';
const LOG_FILE = '/home/mk19/paxiom/opportunities.log';

const POOLS = [
  { chain: 'arbitrum', dex: 'uniswap', asset: 'ETH', rpc: 'https://arb1.arbitrum.io/rpc', pool: '0xC6962004f452bE9203591991D15f6b388e09E8D0', decimals: 12 },
  { chain: 'base', dex: 'uniswap', asset: 'ETH', rpc: 'https://mainnet.base.org', pool: '0xd0b53D9277642d899DF5C87A3966A349A798F224', decimals: 12 },
  { chain: 'optimism', dex: 'uniswap', asset: 'ETH', rpc: 'https://mainnet.optimism.io', pool: '0x85149247691df622eaF1a8Bd0CaFd40BC45154a9', decimals: 12 },
  { chain: 'base', dex: 'aerodrome', asset: 'ETH', rpc: 'https://mainnet.base.org', pool: '0xb2cc224c1c9feE385f8ad6a55b4d94E92359DC59', decimals: 12 },
  { chain: 'arbitrum', dex: 'uniswap', asset: 'WBTC', rpc: 'https://arb1.arbitrum.io/rpc', pool: '0xA62aD78825E3a55A77823F00Fe0050F567c1e4EE', decimals: 2 },
  { chain: 'optimism', dex: 'uniswap', asset: 'WBTC', rpc: 'https://mainnet.optimism.io', pool: '0x73B14a78a0D396C521f954532d43fd5fFe385216', decimals: 2 },
  { chain: 'arbitrum', dex: 'uniswap', asset: 'wstETH', rpc: 'https://arb1.arbitrum.io/rpc', pool: '0x35218a1cbaC5Bbc3E57fd9Bd38219D37571b3537', decimals: 0 },
  { chain: 'optimism', dex: 'uniswap', asset: 'wstETH', rpc: 'https://mainnet.optimism.io', pool: '0x04F6C85A1B00F6D9B75f91FD23835974Cc07E65c', decimals: 0 },
  { chain: 'arbitrum', dex: 'uniswap', asset: 'ARB', rpc: 'https://arb1.arbitrum.io/rpc', pool: '0xcDa53B1F66614552F834cEeF361A8D12a0B8DaD8', decimals: 12 },
  { chain: 'optimism', dex: 'uniswap', asset: 'OP', rpc: 'https://mainnet.optimism.io', pool: '0xbce00644e5535b68daf73d1528e8b08e6a14472c', decimals: 12 },
  { chain: 'base', dex: 'uniswap', asset: 'cbETH', rpc: 'https://mainnet.base.org', pool: '0xa9dafa443a02fbc907cb0093276b3e6f4ef02a46', decimals: 0 },
  { chain: 'arbitrum', dex: 'uniswap', asset: 'USDT', rpc: 'https://arb1.arbitrum.io/rpc', pool: '0xbce73c2e5a623054b0e8e2428e956f4b9d0412a5', decimals: 12 },
  { chain: 'optimism', dex: 'uniswap', asset: 'USDT', rpc: 'https://mainnet.optimism.io', pool: '0xbce00644e5535b68daf73d1528e8b08e6a14472c', decimals: 12 },
];

const spreadHistory = {};
const velocityHistory = {};
const FLASH_FEE = 0.0005;
const GAS_COST = 50;
const LOAN_SIZES = [1000000, 5000000, 10000000];

const SETTINGS = {
  wstETH: {
    logThreshold: 0.03,
    capturableThreshold: 0.035,
    minSpreadChange: 0.002,
    logCooldown: 1800
  },
  default: {
    logThreshold: 0.05,
    capturableThreshold: 0.05,
    minSpreadChange: 0.005,
    logCooldown: 60
  }
};

function getSettings(asset) {
  return SETTINGS[asset] || SETTINGS.default;
}

// State file for dedup — persists across restarts
const STATE_FILE = '/home/mk19/paxiom/sdk/dedup-state.json';
let dedupState = {};
try {
  dedupState = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
} catch(e) {
  dedupState = {};
}

function shouldLog(asset, spreadPct, buyChain, sellChain) {
  const settings = getSettings(asset);
  if (spreadPct < settings.logThreshold) return false;

  const key = asset + '-' + buyChain + '-' + sellChain;
  const last = dedupState[key];
  if (!last) return true;

  const timeSince = (Date.now() - last.timestamp) / 1000;
  const spreadChange = Math.abs(spreadPct - last.spread);

  return timeSince >= settings.logCooldown || spreadChange >= settings.minSpreadChange;
}

function updateDedupState(asset, spreadPct, buyChain, sellChain) {
  const key = asset + '-' + buyChain + '-' + sellChain;
  dedupState[key] = { spread: spreadPct, timestamp: Date.now() };
  try {
    writeFileSync(STATE_FILE, JSON.stringify(dedupState));
  } catch(e) {}
}

async function fetchPoolPrice(entry) {
  try {
    const res = await fetch(entry.rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_call',
        params: [{ to: entry.pool, data: '0x3850c7bd' }, 'latest']
      })
    });
    const json = await res.json();
    if (!json.result || json.result === '0x') return null;
    const sqrtPriceX96 = BigInt('0x' + json.result.slice(2, 66));
    const Q96 = BigInt(2) ** BigInt(96);
    const price = Number(sqrtPriceX96 * sqrtPriceX96 * BigInt(10 ** entry.decimals)) / Number(Q96 * Q96);
    if (price < 0.0001 || price > 10000000) return null;
    return price;
  } catch(e) { return null; }
}

function calcProfit(spreadPct, loanSize) {
  return loanSize * (spreadPct / 100) - loanSize * FLASH_FEE - GAS_COST;
}

function analyzeVelocity(asset, spreadPct, buyChain, sellChain) {
  const now = Date.now();
  if (!velocityHistory[asset]) velocityHistory[asset] = [];
  velocityHistory[asset].push({ spread: spreadPct, buyChain, sellChain, timestamp: now });
  if (velocityHistory[asset].length > 10) velocityHistory[asset].shift();

  const h = velocityHistory[asset];
  if (h.length < 3) return null;

  const recent = h.slice(-3);
  const delta = recent[2].spread - recent[0].spread;
  const timeDelta = (recent[2].timestamp - recent[0].timestamp) / 1000;
  if (timeDelta === 0) return { trend: 'STABLE', capturable: false, velocity: '0', sameDir: true };

  const velocity = delta / timeDelta;
  const sameDir = recent.every(r => r.buyChain === recent[0].buyChain);
  const opening = delta > 0;
  const settings = getSettings(asset);

  const capturable = asset === 'wstETH'
    ? sameDir && spreadPct > settings.capturableThreshold
    : sameDir && opening && spreadPct > settings.capturableThreshold;

  return {
    trend: opening ? 'OPENING' : delta < 0 ? 'CLOSING' : 'STABLE',
    capturable,
    velocity: velocity.toFixed(6),
    sameDir
  };
}

async function main() {
  console.log(`\n[${new Date().toISOString()}] Scanning ${POOLS.length} pools...`);

  const results = await Promise.all(POOLS.map(async entry => {
    const price = await fetchPoolPrice(entry);
    return { ...entry, price };
  }));

  const byAsset = {};
  for (const r of results) {
    if (!r.price) continue;
    if (!byAsset[r.asset]) byAsset[r.asset] = [];
    byAsset[r.asset].push(r);
    console.log(`${r.asset} ${r.chain}/${r.dex}: $${r.price.toFixed(4)}`);
  }

  console.log('\n--- SPREADS & VELOCITY ---');
  for (const [asset, entries] of Object.entries(byAsset)) {
    if (entries.length < 2) continue;

    const prices = entries.map(e => e.price);
    const max = Math.max(...prices);
    const min = Math.min(...prices);
    const spreadPct = (max - min) / min * 100;
    const maxEntry = entries.find(e => e.price === max);
    const minEntry = entries.find(e => e.price === min);

    if (!spreadHistory[asset]) spreadHistory[asset] = [];
    spreadHistory[asset].push({ spread: spreadPct, buyChain: minEntry.chain, sellChain: maxEntry.chain });
    if (spreadHistory[asset].length > 5) spreadHistory[asset].shift();

    const history = spreadHistory[asset];
    let persistenceFlag = '';
    if (history.length >= 3) {
      const last3 = history.slice(-3);
      const sameDir = last3.every(h => h.buyChain === last3[0].buyChain && h.sellChain === last3[0].sellChain);
      const settings = getSettings(asset);
      if (sameDir && spreadPct > settings.logThreshold) persistenceFlag = ' *** PERSISTENT ***';
    }

    const velocity = analyzeVelocity(asset, spreadPct, minEntry.chain, maxEntry.chain);
    const oppFlag = spreadPct > 0.1 ? ' *** OPPORTUNITY ***' : '';

    console.log(`${asset}: ${spreadPct.toFixed(4)}% | buy ${minEntry.chain}/${minEntry.dex} | sell ${maxEntry.chain}/${maxEntry.dex}${oppFlag}${persistenceFlag}`);

    if (velocity) {
      const capStr = velocity.capturable ? ' ✅ CAPTURABLE' : '';
      console.log(`  Velocity: ${velocity.trend} | ${velocity.sameDir ? 'consistent' : 'flipping'} direction${capStr}`);
    }

    for (const loan of LOAN_SIZES) {
      const net = calcProfit(spreadPct, loan);
      if (net > 0) console.log(`  $${(loan/1000000).toFixed(0)}M loan → $${net.toFixed(0)} net profit`);
    }

    if (shouldLog(asset, spreadPct, minEntry.chain, maxEntry.chain)) {
      updateDedupState(asset, spreadPct, minEntry.chain, maxEntry.chain);
      appendFileSync(LOG_FILE,
        JSON.stringify({
          timestamp: new Date().toISOString(),
          asset,
          spreadPct: spreadPct.toFixed(4),
          buyChain: minEntry.chain,
          buyDex: minEntry.dex,
          sellChain: maxEntry.chain,
          sellDex: maxEntry.dex,
          buyPrice: min.toFixed(4),
          sellPrice: max.toFixed(4),
          persistent: persistenceFlag.length > 0,
          velocity: velocity ? velocity.trend : 'unknown',
          capturable: velocity ? velocity.capturable : false
        }) + '\n'
      );
    }
  }

  console.log('\n--- SUMMARY ---');
  const opps = Object.entries(byAsset)
    .filter(([_, e]) => e.length >= 2)
    .map(([asset, entries]) => {
      const prices = entries.map(e => e.price);
      const max = Math.max(...prices);
      const min = Math.min(...prices);
      return { asset, spread: (max - min) / min * 100 };
    })
    .sort((a, b) => b.spread - a.spread);

  if (opps.length > 0) console.log('Largest spread:', opps[0].asset, opps[0].spread.toFixed(4) + '%');
  console.log('Pools responding:', results.filter(r => r.price).length, '/', POOLS.length);
}

async function loop() {
  while(true) {
    await main();
    console.log('\nNext scan in 10 seconds...');
    await new Promise(r => setTimeout(r, 10000));
  }
}

loop();
