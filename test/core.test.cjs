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
const { createSlot0ZkInput } = require('../core/slot0-zk-input');
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
const {
  assignJobToWorker,
  createAoDispatch,
  createJobAttempt,
  createRecursiveAggregationPlan,
  createZkPredicateJob,
  createZkProofReceipt,
  dedupeJobs,
  isJobAttemptStale,
  nextJobAttempt,
  receiptKey
} = require('../core/zk-pipeline');
const {
  cacheKey,
  getOrPutWitnessCacheEntry,
  protocolMetadataCacheInput,
  readWitnessCache
} = require('../core/witness-cache');
const {
  GOLDILOCKS_PRIME,
  keccakF1600CostModel,
  validateEthereumKeccakVectors
} = require('../core/goldilocks-keccak');
const {
  decodeCompactPath,
  stableWitnessPayload,
  summarizeProofNode
} = require('../core/eip1186-witness');
const { createExpanderKeccakBatch } = require('../core/expander-keccak-batch');
const { assertKeccakDigest, traceKeccak256 } = require('../core/keccak-trace');
const {
  compareKeccakBackends,
  estimateKeccacheckBatch,
  estimateExpanderBatch,
  keccakPermutationsForBytes,
  planKeccacheckForInclusionWitness
} = require('../core/keccacheck-model');
const {
  assertUsableWitness,
  proveEthereumInclusion
} = require('../sdk/ethereum-inclusion-backend.cjs');
const { backendFromEnv } = require('../sdk/prover-backend.cjs');
const { verifyAccountProof } = require('../core/eth-proof');
const { appendFileSync, mkdtempSync, rmSync } = require('fs');
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

  assert.strictEqual(policy.resolveExecutionNetwork({ PAXIOM_NETWORK: 'testnet' }), 'testnet');
  assert.strictEqual(policy.resolveExecutionNetwork({ PAXIOM_NETWORK: 'mainnet' }), 'mainnet');
  assert.throws(() => policy.resolveExecutionNetwork({}), /PAXIOM_NETWORK/);
  assert.throws(
    () => policy.assertExecutionStartupSafety({
      network: 'mainnet',
      executionEnabled: true,
      requireGenesisProof: false
    }),
    /Refusing mainnet execution/
  );
  assert.doesNotThrow(() => policy.assertExecutionStartupSafety({
    network: 'testnet',
    executionEnabled: true,
    requireGenesisProof: false
  }));

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

async function testEthProofRejectsAddressMismatch() {
  await assert.rejects(
    () => verifyAccountProof(root(1), {
      address: '0x0000000000000000000000000000000000000001',
      accountProof: [],
      nonce: '0x0',
      balance: '0x0',
      storageHash: root(2),
      codeHash: root(3)
    }, '0x0000000000000000000000000000000000000002'),
    /proof address mismatch/
  );
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

async function testSlot0ZkInputMatchesDecoder() {
  const value = '0x14402d302d3002003087c00000000000050e9746adb56d1f730441fac50a7';
  const decoded = decodeSlot0(value);
  const input = createSlot0ZkInput(value);

  assert.strictEqual(input.sqrtPriceX96, decoded.sqrtPriceX96);
  assert.strictEqual(input.observationIndex, decoded.observationIndex);
  assert.strictEqual(input.observationCardinality, decoded.observationCardinality);
  assert.strictEqual(input.observationCardinalityNext, decoded.observationCardinalityNext);
  assert.strictEqual(input.feeProtocol, decoded.feeProtocol);
  assert.strictEqual(input.unlockedByte, decoded.unlocked ? '1' : '0');
  assert.strictEqual(input.tickRaw, String((BigInt(decoded.tick) + (1n << 24n)) % (1n << 24n)));
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
      proof_receipt: { kind: 'ZK_PREDICATE_PROOF', commitment: 'zk-receipt' },
      witness_commitment: 'witness-commitment',
      mpt_proof_hash: 'mpt-proof-hash',
      paxiom_commitment: 'fact-commitment',
      verification_level: 'mpt_verified'
    }, { signingKey: 'test-key' });

    appendFeedItem(item, file);
    assert.strictEqual(item.custody, 'none');
    assert.strictEqual(item.proof_receipt.commitment, 'zk-receipt');
    assert.strictEqual(item.witness_commitment, 'witness-commitment');
    assert.strictEqual(item.mpt_proof_hash, 'mpt-proof-hash');
    assert.strictEqual(item.signature.length, 64);
    assert.strictEqual(latestFeedItems({ limit: 1, file }).length, 1);
    appendFileSync(file, '{"partial":');
    assert.strictEqual(latestFeedItems({ limit: 5, file }).length, 1);

    const found = findByCommitment('fact-commitment', file);
    assert.strictEqual(found.paxiom_commitment, 'fact-commitment');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testFeedAuthScopes() {
  const subscribers = parseSubscribers({
    PAXIOM_FEED_SUBSCRIBERS: JSON.stringify([
      { id: 'slot0-only', token_hash: hashToken('slot0-token'), scopes: ['predicate:uniswap_v3_slot0'] },
      { id: 'pool-only', token_hash: hashToken('pool-token'), scopes: ['subject:ethereum:pool:slot0'] },
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
  const pool = authenticateToken('pool-token', subscribers);
  const all = authenticateToken('all-token', subscribers);

  assert.strictEqual(scoped.id, 'slot0-only');
  assert.strictEqual(all.id, 'all-access');
  assert.strictEqual(authenticateToken('wrong-token', subscribers), null);
  assert.strictEqual(itemAllowedForSubscriber(slot0, scoped), true);
  assert.strictEqual(itemAllowedForSubscriber(storage, scoped), false);
  assert.strictEqual(itemAllowedForSubscriber(slot0, pool), true);
  assert.strictEqual(itemAllowedForSubscriber(storage, pool), false);
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

async function testZkPipelinePlansParallelJobs() {
  const job = createZkPredicateJob({
    predicate: 'uniswap_v3_slot0',
    subject: 'ethereum:0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640:slot0',
    block_number: 24962138,
    state_root: root(9),
    public_inputs: { pool: '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640' },
    target_proof_system: 'groth16-mpt-slot0-v1'
  });

  const assignment = assignJobToWorker(job, 8);
  const dispatch = createAoDispatch(job, 8);
  const receipt = createZkProofReceipt({
    job,
    proof_system: 'groth16-mpt-slot0-v1',
    proof_hash: 'proof:slot0:24962138',
    verifier_id: 'slot0-verifier-v1',
    public_outputs: { tick: '198871' }
  });
  const plan = createRecursiveAggregationPlan([receipt]);

  assert.strictEqual(job.kind, 'ZK_PREDICATE_JOB');
  assert.strictEqual(job.subject, 'ethereum:0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640:slot0');
  assert.ok(assignment.worker_id.startsWith('ao-zk-worker-'));
  assert.strictEqual(dispatch.tags.find(tag => tag.name === 'Action').value, 'ProveZkPredicate');
  assert.strictEqual(receipt.job_id, job.job_id);
  assert.strictEqual(receiptKey(receipt), `24962138:uniswap_v3_slot0:${job.subject}:${job.job_id}`);
  assert.strictEqual(plan.receipt_commitments[0], receipt.commitment);
}

async function testProverBackendSelection() {
  assert.strictEqual(backendFromEnv({}).kind, 'snarkjs');
  assert.strictEqual(backendFromEnv({ PAXIOM_ZK_PROVER_BACKEND: 'rapidsnark' }).mode, 'accelerated-native');
  assert.throws(
    () => backendFromEnv({ PAXIOM_ZK_PROVER_BACKEND: 'external' }),
    /PAXIOM_ZK_PROVER_CMD/
  );
}

async function testGoldilocksKeccakExperimentPrimitives() {
  assert.strictEqual(GOLDILOCKS_PRIME.toString(), '18446744069414584321');

  const vectors = validateEthereumKeccakVectors();
  assert.ok(vectors.every(vector => vector.ok));
  assert.strictEqual(vectors[1].selector, '0xa9059cbb');
  assert.strictEqual(vectors[2].selector, '0x70a08231');

  const cost = keccakF1600CostModel();
  assert.strictEqual(cost.rounds, 24);
  assert.strictEqual(cost.bitsPerLane, 64);
  assert.ok(cost.bitAnds > 0);
  assert.ok(cost.bitXors > cost.bitAnds);
}

async function testZkJobAttemptsAndDedupe() {
  const job = createZkPredicateJob({
    predicate: 'uniswap_v3_slot0',
    subject: 'ethereum:pool:slot0',
    block_number: 1,
    state_root: root(1)
  });
  const duplicate = createZkPredicateJob({
    predicate: 'uniswap_v3_slot0',
    subject: 'ethereum:pool:slot0',
    block_number: 1,
    state_root: root(1)
  });

  assert.strictEqual(dedupeJobs([job, duplicate]).length, 1);

  const attempt = createJobAttempt(job, {
    worker_id: 'ao-zk-worker-0',
    deadline_at: '2020-01-01T00:00:00.000Z'
  });
  assert.strictEqual(isJobAttemptStale(attempt, new Date('2020-01-01T00:00:01.000Z')), true);
  const retry = nextJobAttempt(attempt, { max_attempts: 3 });
  assert.strictEqual(retry.attempt, 2);
}

async function testWitnessCache() {
  const dir = mkdtempSync(join(tmpdir(), 'paxiom-cache-'));
  try {
    const file = join(dir, 'cache.json');
    const input = protocolMetadataCacheInput({
      protocol: 'uniswap_v3_slot0',
      subject: 'Ethereum:Pool'
    });
    const key = cacheKey('protocol_metadata', input);
    const first = getOrPutWitnessCacheEntry({
      kind: 'protocol_metadata',
      input,
      file,
      produce: () => ({ slot: '0x0' })
    });
    const second = getOrPutWitnessCacheEntry({
      kind: 'protocol_metadata',
      input,
      file,
      produce: () => ({ slot: '0x1' })
    });
    assert.strictEqual(first.hit, false);
    assert.strictEqual(second.hit, true);
    assert.strictEqual(first.entry.key, key);
    assert.strictEqual(readWitnessCache(file).entries[key].value.slot, '0x0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testEthereumInclusionWitnessPrimitives() {
  const branch = summarizeProofNode('0xd18080808080808080808080808080808080', 0);
  assert.strictEqual(branch.node_type, 'branch');
  assert.strictEqual(branch.item_count, 17);
  assert.strictEqual(branch.byte_length, 18);
  assert.strictEqual(branch.child_refs.length, 16);

  const leafPath = decodeCompactPath(Uint8Array.from([0x20, 0xab, 0xcd]));
  assert.strictEqual(leafPath.kind, 'leaf');
  assert.strictEqual(leafPath.is_odd, false);
  assert.deepStrictEqual(leafPath.nibbles, [10, 11, 12, 13]);

  const extensionPath = decodeCompactPath(Uint8Array.from([0x11, 0x23]));
  assert.strictEqual(extensionPath.kind, 'extension');
  assert.strictEqual(extensionPath.is_odd, true);
  assert.deepStrictEqual(extensionPath.nibbles, [1, 2, 3]);
}

async function testEthereumInclusionBackendScaffold() {
  const witness = {
    schema: 'paxiom.ethereum_inclusion_witness.v1',
    generated_at: '2026-04-26T00:00:00.000Z',
    verified_offchain: true,
    root_checks: {
      account_root_matches_state_root: true,
      storage_root_matches_account_storage_hash: true
    },
    public_inputs: {
      state_root: root(1),
      address_hash: root(2),
      storage_root: root(3),
      storage_key_hash: root(4),
      storage_value: '0x01'
    }
  };

  assert.doesNotThrow(() => assertUsableWitness(witness));
  assert.deepStrictEqual(Object.keys(stableWitnessPayload(witness)).includes('generated_at'), false);

  const proof = proveEthereumInclusion(witness, { backend: 'mock-normalized' });
  assert.strictEqual(proof.kind, 'ETHEREUM_INCLUSION_BACKEND_PROOF');
  assert.strictEqual(proof.proves_in_circuit, false);
  assert.ok(proof.next_backend_targets.some(target => target.backend === 'goldilocks-stark'));
  assert.throws(() => proveEthereumInclusion(witness, { backend: 'circom-keccak-mpt' }), /not wired yet/);
}

async function testKeccacheckBatchModel() {
  assert.strictEqual(keccakPermutationsForBytes(0), 1);
  assert.strictEqual(keccakPermutationsForBytes(135), 1);
  assert.strictEqual(keccakPermutationsForBytes(136), 2);
  assert.strictEqual(keccakPermutationsForBytes(532), 4);

  const batch = estimateKeccacheckBatch(17);
  assert.strictEqual(batch.padded_instances, 32);
  assert.strictEqual(batch.num_variables, 11);
  assert.strictEqual(batch.estimated_constraints, 960572);

  const expander = estimateExpanderBatch(4500);
  assert.strictEqual(expander.estimated_proving_seconds, 1);
  assert.strictEqual(expander.estimated_peak_memory_mb, 72000);
  assert.ok(compareKeccakBackends(64).expander_speedup_vs_keccacheck_estimate > 1);

  const witness = {
    schema: 'paxiom.ethereum_inclusion_witness.v1',
    commitment: 'witness:1',
    target: { block_number: '1' },
    account_proof_nodes: [
      { index: 0, byte_length: 532, keccak: root(1) },
      { index: 1, byte_length: 20, keccak: root(2) }
    ],
    storage_proof_nodes: [
      { index: 0, byte_length: 136, keccak: root(3) }
    ]
  };
  const plan = planKeccacheckForInclusionWitness(witness, { maxBatchSize: 1024 });
  assert.strictEqual(plan.total_keccak_permutations, 9);
  assert.strictEqual(plan.batches[0].padded_instances, 16);
  assert.strictEqual(plan.backend_comparisons.length, 1);
  assert.ok(plan.commitment);
}

async function testKeccakTraceVectors() {
  assert.strictEqual(
    assertKeccakDigest('', '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'),
    '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'
  );
  assert.strictEqual(
    traceKeccak256('transfer(address,uint256)').digest,
    '0xa9059cbb2ab09eb219583f4a59a5d0623ade346d962bcd4e46b11da047c9049b'
  );
  assert.strictEqual(traceKeccak256(new Uint8Array(136)).permutations.length, 2);
}

async function testExpanderKeccakBatchFromWitness() {
  const witness = {
    schema: 'paxiom.ethereum_inclusion_witness.v1',
    commitment: 'witness:test',
    target: {
      address: '0x0000000000000000000000000000000000000000',
      storage_slot: '0x0',
      block_number: '1'
    },
    account_proof_nodes: [
      {
        index: 0,
        rlp: '0xd18080808080808080808080808080808080',
        keccak: traceKeccak256('0xd18080808080808080808080808080808080').digest,
        node_type: 'branch',
        byte_length: 18
      }
    ],
    storage_proof_nodes: []
  };
  const batch = createExpanderKeccakBatch(witness, {
    generatedAt: '2026-04-26T00:00:00.000Z'
  });
  assert.strictEqual(batch.schema, 'paxiom.expander_keccak_batch.v1');
  assert.strictEqual(batch.tasks.length, 3);
  assert.strictEqual(batch.permutation_count, 3);
  assert.strictEqual(batch.tasks[0].expected_digest, traceKeccak256('0x0000000000000000000000000000000000000000').digest);
  assert.ok(batch.commitment);
}

(async () => {
  await testCoreReplay();
  await testReducerRejectsReplay();
  await testExecutionPolicy();
  await testEthProofRejectsAddressMismatch();
  await testProofCorpusAggregation();
  await testProofCorpusRejectsGaps();
  await testFactProofBindsToCorpus();
  await testUniswapV3Slot0Decode();
  await testSlot0ZkInputMatchesDecoder();
  await testFeedStore();
  await testFeedAuthScopes();
  await testPredicateCatalog();
  await testZkPipelinePlansParallelJobs();
  await testProverBackendSelection();
  await testGoldilocksKeccakExperimentPrimitives();
  await testZkJobAttemptsAndDedupe();
  await testWitnessCache();
  await testEthereumInclusionWitnessPrimitives();
  await testEthereumInclusionBackendScaffold();
  await testKeccacheckBatchModel();
  await testKeccakTraceVectors();
  await testExpanderKeccakBatchFromWitness();
  console.log('All tests passed');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
