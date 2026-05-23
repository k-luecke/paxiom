import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// We test the server by spinning it up against a temp PAXIOM_DIR. The runner
// auto-generates an operator key on first boot which writes to disk; using a
// temp dir keeps tests isolated from the user's real key store.
async function startRunner({ extraEnv = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'arb-runner-test-'));
  const keyDir = join(dir, '.arb-runner');
  // Pre-stage env so the imported module reads from temp paths.
  Object.assign(process.env, {
    PAXIOM_DIR: dir,
    OPERATOR_KEY_DIR: keyDir,
    OPERATOR_KEY_FILE: join(keyDir, 'operator.key'),
    EXEC_LOG: join(dir, 'execution.log'),
    UNWIND_LOG: join(dir, 'unwind.log'),
    KILL_FILE: join(dir, 'kill.flag'),
    ARB_RUNNER_PORT: '0',
    ...extraEnv,
  });
  // Bust import cache by appending a query param-like suffix; ESM doesn't
  // support that natively, so we rely on the per-test dir for state isolation.
  const mod = await import(`../server.mjs?t=${Date.now()}-${Math.random()}`);
  return new Promise((resolve) => {
    const app = mod.createApp();
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({
        server, dir, mod,
        url: `http://127.0.0.1:${server.address().port}`,
        cleanup: () => {
          server.close();
          try { rmSync(dir, { recursive: true, force: true }); } catch {}
        },
      });
    });
  });
}

async function getJson(url, path) {
  const r = await fetch(`${url}${path}`);
  return { status: r.status, body: await r.json() };
}
async function postJson(url, path, body) {
  const r = await fetch(`${url}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: r.status, body: await r.json() };
}

test('runner exposes wallet, status, performance', async () => {
  const ctx = await startRunner();
  try {
    const health = await getJson(ctx.url, '/healthz');
    assert.equal(health.status, 200);
    assert.equal(health.body.service, 'ARB-RUNNER');

    const status = await getJson(ctx.url, '/v1/runner/status');
    assert.equal(status.status, 200);
    assert.equal(status.body.running, false);
    assert.equal(status.body.emergencyClosed, false);

    const perf = await getJson(ctx.url, '/v1/runner/performance');
    assert.equal(perf.status, 200);
    assert.equal(perf.body.attempts, 0);
  } finally { ctx.cleanup(); }
});

test('balance planner computes route and pair deficits', async () => {
  const ctx = await startRunner();
  try {
    const balances = {
      optimism: { ok: true, usdc: 0.25, weth: 0, native: 0 },
      base: { ok: true, usdc: 0, weth: 0.0001, native: 0.01 },
      arbitrum: { ok: true, usdc: 0, weth: 0, native: 0 },
    };
    const route = ctx.mod.buildBalancePlan({
      balances,
      tradeSizeUsd: 1,
      buyChain: 'optimism',
      sellChain: 'base',
      strategy: 'route',
      bufferPct: 10,
      gasEth: 0.001,
    });
    assert.equal(route.ok, false);
    assert.ok(Math.abs(route.perChain.optimism.deficits.usdc - 0.85) < 1e-9);
    assert.ok(Math.abs(route.perChain.optimism.deficits.eth - 0.001) < 1e-12);
    assert.equal(route.perChain.base.deficits.weth, 0);
    assert.equal(route.perChain.base.deficits.eth, 0);
    assert.deepEqual(route.actions.map((a) => [a.chain, a.asset, a.rounded]), [
      ['optimism', 'usdc', 0.85],
      ['optimism', 'eth', 0.001],
    ]);

    const pair = ctx.mod.buildBalancePlan({
      balances,
      tradeSizeUsd: 1,
      buyChain: 'optimism',
      sellChain: 'base',
      strategy: 'pair',
      bufferPct: 10,
      gasEth: 0.001,
    });
    assert.ok(pair.actions.some((a) => a.chain === 'base' && a.asset === 'usdc'));
    assert.ok(pair.actions.some((a) => a.chain === 'optimism' && a.asset === 'eth'));
    assert.ok(!pair.actions.some((a) => a.asset === 'weth'));
  } finally { ctx.cleanup(); }
});

test('test-half-fill injects HALF_BUY into execution.log with synthetic flag + forcedCategory', async () => {
  const ctx = await startRunner();
  try {
    const r = await postJson(ctx.url, '/v1/runner/test-half-fill', { which: 'sell' });
    assert.equal(r.status, 200);
    assert.equal(r.body.injected, true);
    assert.equal(r.body.forcedCategory, 'HALF_BUY');
    assert.match(r.body.tradeId, /^synthetic-/);

    // Verify the entry was actually written to execution.log
    const execLog = process.env.EXEC_LOG;
    assert.ok(existsSync(execLog), 'execution.log should exist after injection');
    const lines = readFileSync(execLog, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.synthetic, true);
    assert.equal(entry.forcedCategory, 'HALF_BUY');
    assert.equal(entry.source, 'TEST-HALF-FILL');
    assert.equal(entry.status, 'broadcast_success');
    assert.ok(entry.tradeId);
    assert.ok(entry.opportunityId);
    assert.ok(entry.sourceTimestamp);
  } finally { ctx.cleanup(); }
});

test('test-half-fill which=buy injects HALF_SELL', async () => {
  const ctx = await startRunner();
  try {
    const r = await postJson(ctx.url, '/v1/runner/test-half-fill', { which: 'buy' });
    assert.equal(r.body.forcedCategory, 'HALF_SELL');
  } finally { ctx.cleanup(); }
});

test('test-crosschain-loop injects BOTH_OK synthetic loop without transactions', async () => {
  const ctx = await startRunner();
  try {
    const r = await postJson(ctx.url, '/v1/runner/test-crosschain-loop', {
      buyChain: 'optimism',
      sellChain: 'base',
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.injected, true);
    assert.equal(r.body.forcedCategory, 'BOTH_OK');
    assert.equal(r.body.noTransactions, true);

    const lines = readFileSync(process.env.EXEC_LOG, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.source, 'TEST-CROSS-CHAIN-LOOP');
    assert.equal(entry.synthetic, true);
    assert.equal(entry.forcedCategory, 'BOTH_OK');
    assert.equal(entry.venueMode, 'synthetic');
    assert.equal(entry.noTransactions, true);
    assert.equal(entry.buyChain, 'optimism');
    assert.equal(entry.sellChain, 'base');
  } finally { ctx.cleanup(); }
});

test('start endpoint refuses if emergency-closed', async () => {
  const ctx = await startRunner();
  try {
    await postJson(ctx.url, '/v1/runner/emergency-close');
    const r = await postJson(ctx.url, '/v1/runner/start', { tradeSizeUsd: 500 });
    assert.equal(r.status, 409);
    assert.match(r.body.reason, /emergency_closed/);
  } finally { ctx.cleanup(); }
});

test('clear-emergency unblocks start', async () => {
  const ctx = await startRunner();
  try {
    await postJson(ctx.url, '/v1/runner/emergency-close');
    const blocked = await postJson(ctx.url, '/v1/runner/start', {});
    assert.equal(blocked.status, 409);
    const cleared = await postJson(ctx.url, '/v1/runner/clear-emergency');
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.emergencyClosed, false);
  } finally { ctx.cleanup(); }
});

test('withdraw rejects bad asset, bad address, bad amount', async () => {
  const ctx = await startRunner();
  try {
    const badAsset = await postJson(ctx.url, '/v1/runner/withdraw', {
      chain: 'base', asset: 'bogus', amount: 1, to: '0x' + '1'.repeat(40),
    });
    assert.equal(badAsset.status, 400);
    assert.match(badAsset.body.error, /asset must be/);

    const badAddr = await postJson(ctx.url, '/v1/runner/withdraw', {
      chain: 'base', asset: 'usdc', amount: 1, to: 'not-an-address',
    });
    assert.equal(badAddr.status, 400);
    assert.match(badAddr.body.error, /20-byte hex/);

    const badAmount = await postJson(ctx.url, '/v1/runner/withdraw', {
      chain: 'base', asset: 'usdc', amount: -1, to: '0x' + '1'.repeat(40),
    });
    assert.equal(badAmount.status, 400);
  } finally { ctx.cleanup(); }
});

test('trades endpoint joins execution + unwind by tradeId', async () => {
  const ctx = await startRunner();
  try {
    // Inject a synthetic half-fill, then a synthetic unwind.log entry that
    // references the same tradeId.
    const inject = await postJson(ctx.url, '/v1/runner/test-half-fill', { which: 'sell' });
    const tradeId = inject.body.tradeId;

    const unwindEntry = {
      detectedAt: new Date().toISOString(),
      tradeId,
      execTimestamp: new Date().toISOString(),
      category: 'HALF_BUY',
      buyTx: { state: 'success' },
      sellTx: { state: 'no_receipt' },
      unwind: { acted: false, reason: 'auto-unwind disabled' },
    };
    writeFileSync(process.env.UNWIND_LOG, JSON.stringify(unwindEntry) + '\n');

    const r = await getJson(ctx.url, '/v1/runner/trades?includeSynthetic=1');
    assert.equal(r.status, 200);
    assert.ok(r.body.trades.length >= 1, 'should have at least one trade');
    const t = r.body.trades.find((t) => t.tradeId === tradeId);
    assert.ok(t, 'should find injected synthetic trade by id');
    assert.equal(t.synthetic, true);
    assert.equal(t.outcome.category, 'HALF_BUY');
    assert.equal(t.outcome.buyState, 'success');
    assert.equal(t.outcome.sellState, 'no_receipt');
  } finally { ctx.cleanup(); }
});

test('trades endpoint excludes synthetic by default', async () => {
  const ctx = await startRunner();
  try {
    await postJson(ctx.url, '/v1/runner/test-half-fill', { which: 'sell' });
    const noSynth = await getJson(ctx.url, '/v1/runner/trades');
    assert.equal(noSynth.body.count, 0);
    const withSynth = await getJson(ctx.url, '/v1/runner/trades?includeSynthetic=1');
    assert.equal(withSynth.body.count, 1);
  } finally { ctx.cleanup(); }
});
