# Paxiom Stage Four Roadmap

Stage four means Paxiom becomes a default proof layer for Ethereum-native market predicates:
subscribers receive live, compact proofs of capital-relevant facts instead of trusting an
indexer, oracle report, or RPC response.

## North Star

```text
Ethereum finalized state
  -> witness generation
  -> parallel AO proving jobs
  -> live ZK predicate proofs
  -> recursive aggregation
  -> subscriber feed/API
```

The current Merkle Patricia proof work is the witness and bootstrapping layer. The target product
is live ZK proof delivery.

## Milestone 1: One Live ZK Predicate Lane

Start with `uniswap_v3_slot0` for selected high-volume pools.

- Development circuit: `zk/circuits/uniswap_v3_slot0.circom`
- Setup command: `npm run zk:setup:slot0`
- Prove command: `npm run zk:prove:slot0 -- --slot0 <hex> --subject <subject> --block <n> --state-root <root>`

- Build the circuit/prover for storage inclusion plus slot0 decoding.
- Generate witnesses from finalized Ethereum blocks.
- Produce one compact proof per pool per block/window.
- Serve the proof receipt through the existing feed API.
- Measure latency, cost, and failure modes.

Exit criteria:

- One pool can be proven repeatedly from finalized blocks.
- Proof receipts include predicate, subject, block, state root, proof hash, verifier id, and commitment.
- Subscriber API can filter and retrieve those receipts.

## Milestone 2: AO Parallel Proving

Split the proving workload by:

```text
predicate x subject x block/window
```

AO workers receive `ZK_PREDICATE_JOB` messages and return `ZK_PREDICATE_PROOF` receipts.
The scheduler assigns jobs deterministically by job commitment so the same job maps to the same shard.

Exit criteria:

- Jobs can be dispatched to multiple AO worker shards.
- Duplicate jobs resolve to the same commitment.
- Invalid/missing receipts are detectable.
- Feed API reports proof freshness and proof system per item.

## Milestone 3: Recursive Aggregation

Aggregate many predicate proofs into compact block/window commitments.

- Block-level aggregation for all predicates in a block.
- Subject-level aggregation for a specific pool/account across a window.
- Global aggregation for subscriber-facing proof roots.

Exit criteria:

- Aggregation commitments are stable and replayable.
- Subscriber can verify a feed item against an aggregate commitment.
- AO corpus records aggregate commitments durably.

## Milestone 4: Predicate Library Moat

Expand beyond pool state:

- `oracle_round_data`
- `aave_health_inputs`
- `oracle_divergence`
- `liquidation_eligibility`
- `event_inclusion`

Each predicate should define:

- witness inputs
- public inputs
- circuit/prover target
- decoded outputs
- subscriber use case
- freshness target
- failure semantics

## Milestone 5: Default Proof Layer

Paxiom is stage-four ready when teams can treat it as infrastructure:

- live proof-backed APIs
- documented verification path
- paid subscribers
- uptime and freshness monitoring
- multiple predicates
- recursive proof roots
- AO-backed public commitments
- clear separation between public commitments and gated live feed access
