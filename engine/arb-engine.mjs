const DEFAULTS = {
  minSpreadPct: Number(process.env.ARB_MIN_SPREAD_PCT || 0.08),
  flashFeeRate: Number(process.env.ARB_FLASH_FEE_RATE || 0.0005),
  gasCostUsd: Number(process.env.ARB_GAS_COST_USD || 50),
  maxTimingGapMs: Number(process.env.ARB_MAX_TIMING_GAP_MS || 30_000),
};

const ALLOWED_CHAINS = new Set(['optimism', 'arbitrum', 'base']);

export function normalizeOpportunity(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('opportunity must be an object');
  }
  const asset = String(input.asset || '').trim();
  const buyChain = String(input.buyChain || '').trim().toLowerCase();
  const sellChain = String(input.sellChain || '').trim().toLowerCase();
  const spreadPct = Number(input.realSpreadPct ?? input.spreadPct);
  const tradeSizeUsd = Number(input.tradeSizeUsd ?? input.loanSizeUsd ?? 10_000);
  const timestamp = input.timestamp || new Date().toISOString();

  if (!asset) throw new Error('asset is required');
  if (!ALLOWED_CHAINS.has(buyChain)) throw new Error(`unsupported buyChain: ${buyChain}`);
  if (!ALLOWED_CHAINS.has(sellChain)) throw new Error(`unsupported sellChain: ${sellChain}`);
  if (buyChain === sellChain) throw new Error('buyChain and sellChain must differ for cross-chain arb');
  if (!Number.isFinite(spreadPct)) throw new Error('spreadPct must be numeric');
  if (!Number.isFinite(tradeSizeUsd) || tradeSizeUsd <= 0) throw new Error('tradeSizeUsd must be positive');

  return {
    id: input.id || `${timestamp}:${asset}:${buyChain}:${sellChain}:${spreadPct}`,
    asset,
    buyChain,
    sellChain,
    buyDex: input.buyDex || 'unknown',
    sellDex: input.sellDex || 'unknown',
    spreadPct,
    tradeSizeUsd,
    timestamp,
    quoteFailed: input.quoteFailed === true,
    persistent: input.persistent === true,
    velocity: input.velocity || 'unknown',
  };
}

export function evaluateOpportunity(input, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const opp = normalizeOpportunity(input);
  const grossProfitUsd = opp.tradeSizeUsd * (opp.spreadPct / 100);
  const flashFeeUsd = opp.tradeSizeUsd * cfg.flashFeeRate;
  const netProfitUsd = grossProfitUsd - flashFeeUsd - cfg.gasCostUsd;
  const reasons = [];

  if (opp.spreadPct < cfg.minSpreadPct) reasons.push('spread_below_threshold');
  if (opp.quoteFailed) reasons.push('quote_failed');
  if (netProfitUsd <= 0) reasons.push('non_positive_net_profit');
  if (opp.velocity === 'CLOSING') reasons.push('spread_closing');

  return {
    service: 'ARB-001',
    dryRun: true,
    executable: reasons.length === 0,
    reasons,
    opportunity: opp,
    economics: {
      grossProfitUsd: roundMoney(grossProfitUsd),
      flashFeeUsd: roundMoney(flashFeeUsd),
      gasCostUsd: roundMoney(cfg.gasCostUsd),
      netProfitUsd: roundMoney(netProfitUsd),
    },
    controls: {
      minSpreadPct: cfg.minSpreadPct,
      flashFeeRate: cfg.flashFeeRate,
      maxTimingGapMs: cfg.maxTimingGapMs,
      liveTransactionsEnabled: process.env.PAXIOM_ENABLE_LIVE_TX === '1',
    },
  };
}

export function createArbEngineState() {
  return {
    running: false,
    startedAt: null,
    stoppedAt: null,
    evaluated: 0,
    lastEvaluation: null,
  };
}

export function startEngine(state) {
  state.running = true;
  state.startedAt = new Date().toISOString();
  state.stoppedAt = null;
  return state;
}

export function stopEngine(state) {
  state.running = false;
  state.stoppedAt = new Date().toISOString();
  return state;
}

export function recordEvaluation(state, evaluation) {
  state.evaluated += 1;
  state.lastEvaluation = evaluation;
  return state;
}

function roundMoney(n) {
  return Math.round(n * 100) / 100;
}
