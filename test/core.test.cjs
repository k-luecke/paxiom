const assert = require('assert');
const { createActionLog, appendAction } = require('../log/action-log');
const { replayActions } = require('../log/replay');
const {
  aggregateSegmentProofs,
  attachAggregate,
  attachFactProof,
  corpusCommitment,
  createFactProof,
  createGenesisAnchor,
  createProofCorpus,
  createSegmentProof
} = require('../core/proof-corpus');

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

  assert.throws(() => policy.requireGenesisProof(valid), /Genesis proof incomplete/);
  assert.doesNotThrow(() => policy.requireGenesisProof({
    ...valid,
    genesisProof: {
      genesis_proven: true,
      genesis_slot: 1,
      genesis_state_root: '0xabc'
    }
  }));

  assert.throws(() => policy.requireExecutionEnabled(), /Execution disabled/);
}

function root(n) {
  return `0x${n.toString(16).padStart(64, '0')}`;
}

async function testProofCorpusAggregation() {
  const genesis = createGenesisAnchor({ genesis_root: root(1) });
  const segment1 = createSegmentProof({
    from_slot: 0,
    to_slot: 32,
    from_state_root: genesis.state_root,
    to_state_root: root(2),
    proof_system: 'mock-stark',
    proof_hash: 'proof:0-32'
  });
  const segment2 = createSegmentProof({
    from_slot: 32,
    to_slot: 64,
    from_state_root: root(2),
    to_state_root: root(3),
    proof_system: 'mock-stark',
    proof_hash: 'proof:32-64'
  });

  const aggregate = aggregateSegmentProofs([segment1, segment2], {
    proof_system: 'mock-recursive-snark'
  });
  const corpus = attachAggregate(createProofCorpus(genesis), aggregate);

  assert.strictEqual(aggregate.from_slot, 0);
  assert.strictEqual(aggregate.to_slot, 64);
  assert.strictEqual(corpus.index.latest_slot, 64);
  assert.strictEqual(corpus.segment_commitments.length, 2);
  assert.ok(corpusCommitment(corpus));
}

async function testProofCorpusRejectsGaps() {
  const segment1 = createSegmentProof({
    from_slot: 0,
    to_slot: 32,
    from_state_root: root(1),
    to_state_root: root(2),
    proof_system: 'mock-stark',
    proof_hash: 'proof:0-32'
  });
  const segment2 = createSegmentProof({
    from_slot: 64,
    to_slot: 96,
    from_state_root: root(2),
    to_state_root: root(3),
    proof_system: 'mock-stark',
    proof_hash: 'proof:64-96'
  });

  assert.throws(() => aggregateSegmentProofs([segment1, segment2]), /Slot gap/);
}

async function testFactProofBindsToCorpus() {
  const genesis = createGenesisAnchor({ genesis_root: root(1) });
  const segment = createSegmentProof({
    from_slot: 0,
    to_slot: 32,
    from_state_root: genesis.state_root,
    to_state_root: root(2),
    proof_system: 'mock-stark',
    proof_hash: 'proof:0-32'
  });
  const aggregate = aggregateSegmentProofs([segment]);
  const corpus = attachAggregate(createProofCorpus(genesis), aggregate);

  const fact = createFactProof({
    slot: 32,
    state_root: root(2),
    predicate: 'storage_equals',
    subject: 'ethereum:0x0000000000000000000000000000000000000000:slot0',
    value: '0x01',
    corpus_commitment: aggregate.commitment,
    witness_hash: 'witness:slot0',
    proof_hash: 'proof:storage-slot0',
    proof_system: 'mock-storage-snark'
  });

  const withFact = attachFactProof(corpus, fact);
  assert.strictEqual(withFact.fact_commitments.length, 1);
  assert.strictEqual(
    withFact.index.facts['32:storage_equals:ethereum:0x0000000000000000000000000000000000000000:slot0'],
    fact.commitment
  );

  const staleFact = { ...fact, corpus_commitment: 'stale' };
  assert.throws(() => attachFactProof(corpus, staleFact), /latest aggregate commitment/);
}

(async () => {
  await testCoreReplay();
  await testReducerRejectsReplay();
  await testExecutionPolicy();
  await testProofCorpusAggregation();
  await testProofCorpusRejectsGaps();
  await testFactProofBindsToCorpus();
  console.log('All tests passed');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
