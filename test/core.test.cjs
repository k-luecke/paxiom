const assert = require('assert');
const { createActionLog, appendAction } = require('../log/action-log');
const { replayActions } = require('../log/replay');

async function testCoreReplay() {
  let log = createActionLog();
  log = appendAction(log, {
    action_id: 'a1',
    sequence: 1,
    type: 'ACCOUNT_CREDIT',
    payload: { account_id: 'acct_1', asset_key: 'ethereum:usdc', amount: '1000' }
  });
  log = appendAction(log, {
    action_id: 'a2',
    sequence: 2,
    type: 'ACCOUNT_DEBIT',
    payload: { account_id: 'acct_1', asset_key: 'ethereum:usdc', amount: '250' }
  });

  const result1 = replayActions(log);
  const result2 = replayActions(log);
  assert.strictEqual(result1.stateHash, result2.stateHash);
  assert.strictEqual(result1.state.accounts.acct_1.balances['ethereum:usdc'].available, '750');
}

async function testReducerRejectsReplay() {
  const log = [
    {
      action_id: 'dup',
      sequence: 1,
      type: 'ACCOUNT_CREDIT',
      payload: { account_id: 'acct_1', asset_key: 'ethereum:usdc', amount: '1' }
    },
    {
      action_id: 'dup',
      sequence: 2,
      type: 'ACCOUNT_CREDIT',
      payload: { account_id: 'acct_1', asset_key: 'ethereum:usdc', amount: '1' }
    }
  ];

  assert.throws(() => replayActions(log), /Duplicate action_id/);
}

async function testExecutionPolicy() {
  const policy = await import('../sdk/execution-policy.js');

  const valid = policy.normalizeOpportunity({
    timestamp: new Date().toISOString(),
    asset: 'ETH',
    spreadPct: '0.1200',
    buyChain: 'Optimism',
    sellChain: 'Base',
    capturable: true
  });
  assert.strictEqual(valid.buyChain, 'optimism');
  assert.strictEqual(valid.sellChain, 'base');
  assert.strictEqual(valid.spreadPct, '0.1200');

  assert.throws(() => policy.normalizeOpportunity({
    timestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    asset: 'ETH',
    spreadPct: '0.1200',
    buyChain: 'optimism',
    sellChain: 'base',
    capturable: true
  }), /stale/);

  assert.throws(() => policy.requireExecutionEnabled(), /Execution disabled/);
}

(async () => {
  await testCoreReplay();
  await testReducerRejectsReplay();
  await testExecutionPolicy();
  console.log('All tests passed');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
