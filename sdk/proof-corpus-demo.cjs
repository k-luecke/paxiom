const {
  aggregateSegmentProofs,
  attachAggregate,
  attachFactProof,
  corpusCommitment,
  createFactProof,
  createGenesisAnchor,
  createProofCorpus,
  createSegmentProof
} = require("../core/proof-corpus");

function root(n) {
  return `0x${n.toString(16).padStart(64, "0")}`;
}

function buildDemoCorpus() {
  const genesis = createGenesisAnchor({ genesis_root: root(1) });
  const segments = [
    createSegmentProof({
      from_slot: 0,
      to_slot: 32,
      from_state_root: genesis.state_root,
      to_state_root: root(2),
      proof_system: "demo-stark",
      proof_hash: "demo-proof:ethereum:0-32"
    }),
    createSegmentProof({
      from_slot: 32,
      to_slot: 64,
      from_state_root: root(2),
      to_state_root: root(3),
      proof_system: "demo-stark",
      proof_hash: "demo-proof:ethereum:32-64"
    })
  ];

  const aggregate = aggregateSegmentProofs(segments, {
    proof_system: "demo-recursive-snark"
  });
  let corpus = attachAggregate(createProofCorpus(genesis), aggregate);

  const fact = createFactProof({
    slot: 64,
    state_root: root(3),
    predicate: "storage_equals",
    subject: "ethereum:demo-contract:slot0",
    value: "0x01",
    corpus_commitment: aggregate.commitment,
    witness_hash: "demo-witness:slot0",
    proof_hash: "demo-proof:storage-slot0",
    proof_system: "demo-storage-snark"
  });
  corpus = attachFactProof(corpus, fact);

  return {
    genesis,
    segments,
    aggregate,
    fact,
    corpus,
    corpus_commitment: corpusCommitment(corpus)
  };
}

if (require.main === module) {
  console.log(JSON.stringify(buildDemoCorpus(), null, 2));
}

module.exports = {
  buildDemoCorpus
};
