import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

test('arb engine starts and evaluates opportunities in dry-run mode', async () => {
  const { server, url } = await listen(createApp());
  try {
    const run = await fetch(`${url}/v1/arb/run`, { method: 'POST' });
    assert.equal(run.status, 200);
    assert.equal((await run.json()).running, true);

    const resp = await fetch(`${url}/v1/arb/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        asset: 'wstETH',
        buyChain: 'optimism',
        sellChain: 'arbitrum',
        spreadPct: '0.95',
        tradeSizeUsd: 100000,
        velocity: 'OPENING',
      }),
    });
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.service, 'ARB-001');
    // The opportunity is profitable on its economics...
    assert.equal(body.evaluatedAsProfitable, true);
    // ...but PAXIOM_ENABLE_LIVE_TX is unset, so the kill switch keeps it
    // unexecutable. executable = profitable && liveTransactionsEnabled, and the
    // env is the ceiling: no caller flag can escalate past it.
    assert.equal(body.liveTransactionsEnabled, false);
    assert.equal(body.executable, false);
    assert.ok(body.reasons.includes('live_transactions_disabled'));
    // dryRun is a caller flag, distinct from the kill switch; it was not sent.
    assert.equal(body.dryRun, false);

    const status = await fetch(`${url}/v1/arb/status`);
    assert.equal((await status.json()).evaluated, 1);
  } finally {
    server.close();
  }
});

test('arb engine rejects unsupported chains', async () => {
  const { server, url } = await listen(createApp());
  try {
    const resp = await fetch(`${url}/v1/arb/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        asset: 'ETH',
        buyChain: 'ethereum',
        sellChain: 'arbitrum',
        spreadPct: '1.0',
      }),
    });
    assert.equal(resp.status, 400);
  } finally {
    server.close();
  }
});
