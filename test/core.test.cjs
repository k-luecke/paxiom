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
const { decodeSlot0 } = require('../core/uniswap-v3');
const {
  appendFeedItem,
  createFeedItem,
  findByCommitment,
  latestFeedItems
} = require('../feed/store');
const {
  authenticateToken,
  filterItemsForSubscriber,
  hashToken,
  itemAllowedForSubscriber,
  parseSubscribers
} = require('../feed/auth');
const { getPredicate, listPredicates } = require('../feed/predicates');
const { mkdtempSync, rmSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');

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

async function testUniswapV3Slot0Decode() {
  const sqrtPriceX96 = 123456789n;
  const tick = -42n;
  const observationIndex = 7n;
  const observationCardinality = 8n;
  const observationCardinalityNext = 9n;
  const feeProtocol = 3n;
  const unlocked = 1n;
  const tickTwosComplement = (1n << 24n) + tick;
  const packed =
    sqrtPriceX96 |
    (tickTwosComplement << 160n) |
    (observationIndex << 184n) |
    (observationCardinality << 200n) |
    (observationCardinalityNext << 216n) |
    (feeProtocol << 232n) |
    (unlocked << 240n);

  const decoded = decodeSlot0(`0x${packed.toString(16)}`);
  assert.strictEqual(decoded.sqrtPriceX96, sqrtPriceX96.toString());
  assert.strictEqual(decoded.tick, tick.toString());
  assert.strictEqual(decoded.observationIndex, observationIndex.toString());
  assert.strictEqual(decoded.observationCardinality, observationCardinality.toString());
  assert.strictEqual(decoded.observationCardinalityNext, observationCardinalityNext.toString());
  assert.strictEqual(decoded.feeProtocol, feeProtocol.toString());
  assert.strictEqual(decoded.unlocked, true);
}

async function testFeedStore() {
  const dir = mkdtempSync(join(tmpdir(), 'paxiom-feed-'));
  const file = join(dir, 'feed.jsonl');
  try {
    const item = createFeedItem({
      feed_id: 'ethereum.uniswap_v3_slot0',
      predicate: 'uniswap_v3_slot0',
      subject: 'ethereum:pool:slot0',
      value: { tick: '1' },
      block_number: 10,
      block_hash: root(4),
      state_root: root(5),
      proof_system: 'eip1186-mpt+uniswap-v3-slot0',
      proof_hash: 'proof-hash',
      paxiom_commitment: 'fact-commitment',
      verification_level: 'mpt_verified'
    }, { signingKey: 'test-key' });

    appendFeedItem(item, file);
    assert.strictEqual(item.custody, 'none');
    assert.strictEqual(item.signature.length, 64);
    assert.strictEqual(latestFeedItems({ limit: 1, file }).length, 1);

    const found = findByCommitment('fact-commitment', file);
    assert.strictEqual(found.paxiom_commitment, 'fact-commitment');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testFeedAuthScopes() {
  const subscribers = parseSubscribers({
    PAXIOM_FEED_SUBSCRIBERS: JSON.stringify([
      { id: 'slot0-only', token_hash: hashToken('slot0-token'), scopes: ['uniswap_v3_slot0'] },
      { id: 'all-access', token_hash: hashToken('all-token'), scopes: ['*'] }
    ])
  });

  const slot0 = {
    feed_id: 'ethereum.uniswap_v3_slot0',
    predicate: 'uniswap_v3_slot0',
    subject: 'ethereum:pool:slot0'
  };
  const storage = {
    feed_id: 'ethereum.storage_equals',
    predicate: 'storage_equals',
    subject: 'ethereum:contract:slot1'
  };

  const scoped = authenticateToken('slot0-token', subscribers);
  const all = authenticateToken('all-token', subscribers);

  assert.strictEqual(scoped.id, 'slot0-only');
  assert.strictEqual(all.id, 'all-access');
  assert.strictEqual(authenticateToken('wrong-token', subscribers), null);
  assert.strictEqual(itemAllowedForSubscriber(slot0, scoped), true);
  assert.strictEqual(itemAllowedForSubscriber(storage, scoped), false);
  assert.strictEqual(filterItemsForSubscriber([slot0, storage], scoped).length, 1);
  assert.strictEqual(filterItemsForSubscriber([slot0, storage], all).length, 2);
}

async function testPredicateCatalog() {
  const live = listPredicates({ includePlanned: false });
  assert.ok(live.some(predicate => predicate.id === 'storage_equals'));
  assert.ok(live.some(predicate => predicate.id === 'uniswap_v3_slot0'));
  assert.strictEqual(getPredicate('uniswap_v3_slot0').status, 'live');
  assert.strictEqual(getPredicate('missing'), null);
}

(async () => {
  await testCoreReplay();
  await testReducerRejectsReplay();
  await testExecutionPolicy();
  await testProofCorpusAggregation();
  await testProofCorpusRejectsGaps();
  await testFactProofBindsToCorpus();
  await testUniswapV3Slot0Decode();
  await testFeedStore();
  await testFeedAuthScopes();
  await testPredicateCatalog();
  console.log('All tests passed');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
