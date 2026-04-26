const ALLOWED_CHAINS = new Set(['optimism', 'base', 'arbitrum']);
const ALLOWED_ASSETS = new Set(['ETH', 'WETH', 'WBTC', 'wstETH', 'ARB', 'OP', 'USDT', 'cbETH']);
const MAX_SIGNAL_AGE_MS = 2 * 60 * 1000;
const MAX_SPREAD_PCT = 25;

export const EXECUTION_ENABLED = process.env.PAXIOM_EXECUTION_ENABLED === 'true';
export const SIGNAL_TOKEN = process.env.PAXIOM_SIGNAL_TOKEN || '';

export function requireExecutionEnabled() {
  if (!EXECUTION_ENABLED) {
    throw new Error('Execution disabled; set PAXIOM_EXECUTION_ENABLED=true to allow wallet transactions');
  }
}

export function requireSignalAuth(req) {
  if (!SIGNAL_TOKEN) {
    throw new Error('Signal endpoint disabled; set PAXIOM_SIGNAL_TOKEN');
  }
  if (req.headers['x-paxiom-signal-token'] !== SIGNAL_TOKEN) {
    throw new Error('Invalid signal token');
  }
}

export function normalizeOpportunity(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Opportunity must be an object');
  }

  const asset = String(raw.asset || '').trim();
  const buyChain = String(raw.buyChain || '').trim().toLowerCase();
  const sellChain = String(raw.sellChain || '').trim().toLowerCase();
  const spreadPct = Number(raw.spreadPct);
  const timestamp = raw.timestamp ? Date.parse(raw.timestamp) : Date.now();

  if (!ALLOWED_ASSETS.has(asset)) throw new Error(`Unsupported asset: ${asset}`);
  if (!ALLOWED_CHAINS.has(buyChain)) throw new Error(`Unsupported buyChain: ${buyChain}`);
  if (!ALLOWED_CHAINS.has(sellChain)) throw new Error(`Unsupported sellChain: ${sellChain}`);
  if (buyChain === sellChain) throw new Error('buyChain and sellChain must differ');
  if (!Number.isFinite(spreadPct) || spreadPct <= 0 || spreadPct > MAX_SPREAD_PCT) {
    throw new Error(`Invalid spreadPct: ${raw.spreadPct}`);
  }
  if (raw.capturable !== true) throw new Error('Opportunity must be capturable');
  if (!Number.isFinite(timestamp)) throw new Error('Invalid timestamp');
  if (Date.now() - timestamp > MAX_SIGNAL_AGE_MS) throw new Error('Opportunity is stale');
  if (timestamp - Date.now() > 30_000) throw new Error('Opportunity timestamp is in the future');

  return {
    ...raw,
    asset,
    buyChain,
    sellChain,
    spreadPct: spreadPct.toFixed(4),
    capturable: true
  };
}
