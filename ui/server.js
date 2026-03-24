import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { spawn, execSync } from 'child_process';
import { createPublicClient, http, formatEther } from 'viem';
import { optimismSepolia } from 'viem/chains';

const PORT = 3000;
const BASE = '/home/mk19/paxiom';

const POOL_ADDRESS = '0x28321b5030B4E03ACCBD4236D1a97E01A7a9fc92';
const POOL_ABI = [
  { name: 'totalLiquidity', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'totalFees',      type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'loanCounter',    type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
];

const publicOp = createPublicClient({ chain: optimismSepolia, transport: http('https://sepolia.optimism.io') });

const PROCESSES = {
  scanner:   { cmd: 'node', args: [`${BASE}/sdk/price-feeder.js`],   log: `${BASE}/scanner.log`,    pid: null },
  simulator: { cmd: 'node', args: [`${BASE}/sdk/signing-daemon.js`], log: `${BASE}/daemon.log`,     pid: null },
  executor:  { cmd: 'node', args: [`${BASE}/sdk/live-executor.js`],  log: `${BASE}/executor.log`,   pid: null },
  aobridge:  { cmd: 'node', args: [`${BASE}/sdk/ao-bridge.js`],      log: `${BASE}/bridge.log`,     pid: null },
};

function getPids() {
  const result = {};
  for (const [name, p] of Object.entries(PROCESSES)) {
    try {
      const script = p.args[0].split('/').pop();
      const out = execSync(`pgrep -f ${script} 2>/dev/null || true`).toString().trim();
      result[name] = out ? parseInt(out.split('\n')[0]) : null;
    } catch(e) { result[name] = null; }
  }
  return result;
}

function startProcess(name) {
  const p = PROCESSES[name];
  if (!p) return { error: 'unknown process' };
  const env = { ...process.env };
  const child = spawn(p.cmd, p.args, {
    detached: true, stdio: 'ignore', env
  });
  child.unref();
  return { started: name, pid: child.pid };
}

function stopProcess(name) {
  const p = PROCESSES[name];
  if (!p) return { error: 'unknown process' };
  try {
    const script = p.args[0].split('/').pop();
    execSync(`pkill -f ${script} 2>/dev/null || true`);
    return { stopped: name };
  } catch(e) { return { error: e.message }; }
}

function getLogTail(logFile, lines = 50) {
  try {
    if (!existsSync(logFile)) return [];
    const content = readFileSync(logFile, 'utf8');
    return content.trim().split('\n').slice(-lines);
  } catch(e) { return []; }
}

function getScannerStats() {
  try {
    const content = readFileSync(`${BASE}/opportunities.log`, 'utf8');
    const lines = content.trim().split('\n').filter(l => l.trim());
    const all = lines.map(l => JSON.parse(l));
    if (!all.length) return { count: 0 };
    const spreads = all.map(o => parseFloat(o.spreadPct));
    const last = all[all.length - 1];
    const recent = all.slice(-10);
    return {
      count: all.length,
      avgSpread: (spreads.reduce((a,b) => a+b,0) / spreads.length).toFixed(4),
      maxSpread: Math.max(...spreads).toFixed(4),
      above05: spreads.filter(s => s >= 0.05).length,
      above10: spreads.filter(s => s >= 0.1).length,
      lastTimestamp: last.timestamp,
      lastAsset: last.asset,
      lastSpread: last.spreadPct,
      lastRoute: `${last.buyChain} -> ${last.sellChain}`,
      recent: recent.map(o => ({
        time: o.timestamp.slice(11,19),
        asset: o.asset,
        spread: o.spreadPct,
        route: `${o.buyChain}->${o.sellChain}`,
        capturable: o.capturable
      }))
    };
  } catch(e) { return { count: 0, error: e.message }; }
}

function getExecutionStats() {
  try {
    const content = readFileSync(`${BASE}/execution.log`, 'utf8');
    const lines = content.trim().split('\n').filter(l => l.trim());
    const all = lines.map(l => JSON.parse(l));
    const success = all.filter(e => e.status === 'broadcast_success');
    const errors  = all.filter(e => e.status === 'error');
    const gaps    = success.map(e => e.timingGapMs).filter(g => g > 0);
    return {
      total: all.length,
      success: success.length,
      errors: errors.length,
      avgGapMs: gaps.length ? Math.round(gaps.reduce((a,b)=>a+b,0)/gaps.length) : 0,
      minGapMs: gaps.length ? Math.min(...gaps) : 0,
      maxGapMs: gaps.length ? Math.max(...gaps) : 0,
      totalProfit: success.reduce((s,e) => s + (e.estimatedProfit||0), 0).toFixed(2),
      recent: all.slice(-10).reverse().map(e => ({
        time: (e.timestamp||'').slice(11,19),
        asset: e.asset,
        spread: e.spreadPct,
        status: e.status,
        gapMs: e.timingGapMs,
        txA: (e.chainATxHash||'').slice(0,12) + '...',
        txB: (e.chainBTxHash||'').slice(0,12) + '...',
      }))
    };
  } catch(e) { return { total: 0, success: 0, errors: 0, error: e.message }; }
}

function getSimStats() {
  try {
    const content = readFileSync(`${BASE}/simulation.log`, 'utf8');
    const lines = content.trim().split('\n').filter(l => l.trim());
    const all = lines.map(l => JSON.parse(l)).filter(l => l.mode === 'SIMULATE');
    const profitable = all.filter(e => e.wouldBeProfitable);
    return {
      total: all.length,
      profitable: profitable.length,
      totalPnl: profitable.reduce((s,e) => s + (e.estimatedProfit||0), 0).toFixed(2),
    };
  } catch(e) { return { total: 0, profitable: 0, totalPnl: '0.00' }; }
}

async function getPoolState() {
  try {
    const [liq, fees, loans] = await Promise.all([
      publicOp.readContract({ address: POOL_ADDRESS, abi: POOL_ABI, functionName: 'totalLiquidity' }),
      publicOp.readContract({ address: POOL_ADDRESS, abi: POOL_ABI, functionName: 'totalFees' }),
      publicOp.readContract({ address: POOL_ADDRESS, abi: POOL_ABI, functionName: 'loanCounter' }),
    ]);
    return {
      totalLiquidity: (Number(liq) / 1e6).toFixed(2),
      totalFees: (Number(fees) / 1e6).toFixed(6),
      loanCounter: Number(loans),
      address: POOL_ADDRESS
    };
  } catch(e) { return { error: e.message }; }
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
}

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }
  cors(res);
  const url = req.url.split('?')[0];

  if (url === '/api/status') {
    const pids = getPids();
    const scanner = getScannerStats();
    const execution = getExecutionStats();
    const sim = getSimStats();
    const pool = await getPoolState();
    res.writeHead(200);
    res.end(JSON.stringify({ pids, scanner, execution, sim, pool, ts: Date.now() }));

  } else if (url === '/api/logs/scanner') {
    res.writeHead(200);
    res.end(JSON.stringify({ lines: getLogTail(`${BASE}/scanner.log`, 30) }));

  } else if (url === '/api/logs/executor') {
    res.writeHead(200);
    res.end(JSON.stringify({ lines: getLogTail(`${BASE}/executor.log`, 30) }));

  } else if (req.method === 'POST' && url.startsWith('/api/process/')) {
    const parts = url.split('/');
    const action = parts[3];
    const name   = parts[4];
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      const result = action === 'start' ? startProcess(name) : stopProcess(name);
      res.writeHead(200);
      res.end(JSON.stringify(result));
    });

  } else if (req.method === 'POST' && url === '/api/signal') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const opp = JSON.parse(body);
        const resp = await fetch('http://0.0.0.0:7070/signal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(opp)
        });
        const result = await resp.json();
        res.writeHead(200);
        res.end(JSON.stringify(result));
      } catch(e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });

  } else if (req.url === '/' || req.url === '/index.html') {
    const html = readFileSync('/home/mk19/paxiom/ui/index.html', 'utf8');
    res.setHeader('Content-Type', 'text/html');
    res.writeHead(200);
    res.end(html);
  } else {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not found' }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Paxiom UI backend running on http://0.0.0.0:${PORT}`);
});
