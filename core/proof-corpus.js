const { hashState } = require("./hash");

const ETHEREUM_GENESIS_ROOT =
  "0xd7f8974fb5ac78d9ac099b9b430502e5ccefe0f1d5518b5fdb5c23b3183a6823";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function isHexRoot(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function hashCommitment(kind, payload) {
  return hashState({
    paxiom_commitment_kind: kind,
    payload
  });
}

function createGenesisAnchor(options = {}) {
  const chain = options.chain || "ethereum";
  const genesisRoot = options.genesis_root || ETHEREUM_GENESIS_ROOT;

  assert(chain === "ethereum", `Unsupported chain: ${chain}`);
  assert(isHexRoot(genesisRoot), "Genesis root must be a 32-byte hex root");

  return {
    kind: "GENESIS_ANCHOR",
    chain,
    slot: 0,
    block_number: 0,
    state_root: genesisRoot,
    commitment: hashCommitment("GENESIS_ANCHOR", {
      chain,
      slot: 0,
      block_number: 0,
      state_root: genesisRoot
    })
  };
}

function createSegmentProof(input) {
  assert(input && typeof input === "object", "Segment proof input must be an object");

  const {
    chain = "ethereum",
    from_slot,
    to_slot,
    from_state_root,
    to_state_root,
    proof_system,
    proof_hash,
    public_inputs = {},
    dependencies = []
  } = input;

  assert(chain === "ethereum", `Unsupported chain: ${chain}`);
  assert(Number.isInteger(from_slot) && from_slot >= 0, "from_slot must be a non-negative integer");
  assert(Number.isInteger(to_slot) && to_slot > from_slot, "to_slot must be greater than from_slot");
  assert(isHexRoot(from_state_root), "from_state_root must be a 32-byte hex root");
  assert(isHexRoot(to_state_root), "to_state_root must be a 32-byte hex root");
  assert(typeof proof_system === "string" && proof_system.length > 0, "proof_system is required");
  assert(typeof proof_hash === "string" && proof_hash.length > 0, "proof_hash is required");
  assert(Array.isArray(dependencies), "dependencies must be an array");

  const segment = {
    kind: "SEGMENT_PROOF",
    chain,
    from_slot,
    to_slot,
    from_state_root,
    to_state_root,
    proof_system,
    proof_hash,
    public_inputs,
    dependencies
  };

  return {
    ...segment,
    commitment: hashCommitment("SEGMENT_PROOF", segment)
  };
}

function verifyContiguousSegments(segments) {
  assert(Array.isArray(segments) && segments.length > 0, "At least one segment is required");

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    assert(segment.kind === "SEGMENT_PROOF", `Invalid segment kind at index ${i}`);
    assert(segment.commitment === hashCommitment("SEGMENT_PROOF", {
      kind: segment.kind,
      chain: segment.chain,
      from_slot: segment.from_slot,
      to_slot: segment.to_slot,
      from_state_root: segment.from_state_root,
      to_state_root: segment.to_state_root,
      proof_system: segment.proof_system,
      proof_hash: segment.proof_hash,
      public_inputs: segment.public_inputs,
      dependencies: segment.dependencies
    }), `Segment commitment mismatch at index ${i}`);

    if (i > 0) {
      const previous = segments[i - 1];
      assert(segment.from_slot === previous.to_slot, `Slot gap before segment ${i}`);
      assert(segment.from_state_root === previous.to_state_root, `State root gap before segment ${i}`);
    }
  }
}

function aggregateSegmentProofs(segments, options = {}) {
  verifyContiguousSegments(segments);

  const first = segments[0];
  const last = segments[segments.length - 1];
  const aggregate = {
    kind: "AGGREGATE_PROOF",
    chain: first.chain,
    from_slot: first.from_slot,
    to_slot: last.to_slot,
    from_state_root: first.from_state_root,
    to_state_root: last.to_state_root,
    proof_system: options.proof_system || "recursive-placeholder",
    aggregation_strategy: options.aggregation_strategy || "ordered-contiguous-fold",
    segment_commitments: segments.map(segment => segment.commitment),
    public_inputs: options.public_inputs || {}
  };

  return {
    ...aggregate,
    commitment: hashCommitment("AGGREGATE_PROOF", aggregate)
  };
}

function createFactProof(input) {
  assert(input && typeof input === "object", "Fact proof input must be an object");

  const {
    chain = "ethereum",
    slot,
    state_root,
    predicate,
    subject,
    value,
    corpus_commitment,
    witness_hash,
    proof_hash,
    proof_system
  } = input;

  assert(chain === "ethereum", `Unsupported chain: ${chain}`);
  assert(Number.isInteger(slot) && slot >= 0, "slot must be a non-negative integer");
  assert(isHexRoot(state_root), "state_root must be a 32-byte hex root");
  assert(typeof predicate === "string" && predicate.length > 0, "predicate is required");
  assert(typeof subject === "string" && subject.length > 0, "subject is required");
  assert(typeof corpus_commitment === "string" && corpus_commitment.length > 0, "corpus_commitment is required");
  assert(typeof witness_hash === "string" && witness_hash.length > 0, "witness_hash is required");
  assert(typeof proof_hash === "string" && proof_hash.length > 0, "proof_hash is required");
  assert(typeof proof_system === "string" && proof_system.length > 0, "proof_system is required");

  const fact = {
    kind: "FACT_PROOF",
    chain,
    slot,
    state_root,
    predicate,
    subject,
    value,
    corpus_commitment,
    witness_hash,
    proof_hash,
    proof_system
  };

  return {
    ...fact,
    commitment: hashCommitment("FACT_PROOF", fact)
  };
}

function createProofCorpus(genesis = createGenesisAnchor()) {
  return {
    version: 1,
    chain: genesis.chain,
    genesis,
    latest_aggregate: null,
    segment_commitments: [],
    fact_commitments: [],
    index: {}
  };
}

function attachAggregate(corpus, aggregate) {
  assert(corpus && corpus.version === 1, "Invalid proof corpus");
  assert(aggregate && aggregate.kind === "AGGREGATE_PROOF", "Invalid aggregate proof");
  assert(aggregate.chain === corpus.chain, "Aggregate chain mismatch");
  assert(aggregate.from_slot === corpus.genesis.slot, "Aggregate must start at genesis slot");
  assert(aggregate.from_state_root === corpus.genesis.state_root, "Aggregate must start at genesis root");

  return {
    ...corpus,
    latest_aggregate: aggregate,
    segment_commitments: aggregate.segment_commitments.slice(),
    index: {
      ...corpus.index,
      latest_slot: aggregate.to_slot,
      latest_state_root: aggregate.to_state_root,
      latest_commitment: aggregate.commitment
    }
  };
}

function attachFactProof(corpus, fact) {
  assert(corpus && corpus.version === 1, "Invalid proof corpus");
  assert(fact && fact.kind === "FACT_PROOF", "Invalid fact proof");
  assert(fact.chain === corpus.chain, "Fact chain mismatch");
  assert(
    corpus.latest_aggregate && fact.corpus_commitment === corpus.latest_aggregate.commitment,
    "Fact must bind to the latest aggregate commitment"
  );

  const factKey = `${fact.slot}:${fact.predicate}:${fact.subject}`;
  return {
    ...corpus,
    fact_commitments: [...corpus.fact_commitments, fact.commitment],
    index: {
      ...corpus.index,
      facts: {
        ...(corpus.index.facts || {}),
        [factKey]: fact.commitment
      }
    }
  };
}

function corpusCommitment(corpus) {
  assert(corpus && corpus.version === 1, "Invalid proof corpus");
  return hashCommitment("PROOF_CORPUS", corpus);
}

module.exports = {
  ETHEREUM_GENESIS_ROOT,
  aggregateSegmentProofs,
  attachAggregate,
  attachFactProof,
  corpusCommitment,
  createFactProof,
  createGenesisAnchor,
  createProofCorpus,
  createSegmentProof,
  hashCommitment,
  verifyContiguousSegments
};
