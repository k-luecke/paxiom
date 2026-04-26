# ZK Production Readiness

This document tracks the engineering work needed to move Paxiom from a working live proof lane
to production-grade subscriber infrastructure.

## Current Completed Boundary

Paxiom currently has a staged live lane for `uniswap_v3_slot0`:

```text
witness generation
  -> proof generation
  -> proof verification
  -> receipt/feed emission
```

Implementation:

- `sdk/zk-slot0-stages.cjs`
- `sdk/prove-live-zk-slot0.cjs`
- `sdk/benchmark-zk-slot0.cjs`
- `core/witness-cache.js`
- `core/zk-pipeline.js`
- `ao-processes/zk-coordinator.lua`

The lane still uses:

```text
off-circuit EIP-1186/MPT verification
  + Groth16 predicate proof for slot0 decoding
```

This is usable for `zk_predicate_verified` receipts, but it is not yet full
`zk_state_inclusion_verified`.

The first concrete Ethereum inclusion slice is now a normalized EIP-1186 witness:

```sh
npm run zk:witness:inclusion -- --address=0x... --slot=0x0 --block=finalized
npm run zk:prove:inclusion -- --witness=.paxiom-runtime/ethereum-inclusion-witness.json
```

This is not yet an in-circuit inclusion proof. It is the exact witness and public-input contract
the real backend must prove.

The first concrete Expander handoff is also available:

```sh
npm run zk:batch:expander-keccak -- --witness=.paxiom-runtime/ethereum-inclusion-witness.json
```

It emits a Keccak-f transition batch for an external Expander worker. The current local runtime
check shows that Expander is cloned and Rust is available, but MPICH/OpenMPI is missing.

## Backend Decision

Use a split backend strategy:

- Groth16/Circom: small predicate relations and subscriber-friendly wrappers.
- Expander/GKR: primary throughput candidate for Keccak-heavy Ethereum inclusion.
- Keccacheck/GKR-style batching: Apache-2.0 fallback and comparison target for Keccak batches.
- Goldilocks/STARK or zkVM: fallback or complement for RLP/MPT-heavy Ethereum inclusion.
- Lattice-based succinct arguments: post-quantum candidate for future transparent/PQ receipts.
- Recursive aggregation: compact block/window roots for subscribers.

Rationale:

- The current slot0 circuit is small.
- Ethereum inclusion is dominated by Keccak/RLP/MPT, not slot decoding.
- Keccak is bitwise and lookup/trace-friendly, not elliptic-curve-endomorphism-friendly.
- Expander reports roughly `4500` Keccak-f permutations per second and explicitly frames
  Ethereum MPT data inclusion as a target use case.
- Keccacheck directly targets batched Keccak-f verification and changes the economics once
  Paxiom batches many trie-node hashes together.
- Goldilocks remains promising for high-throughput proving, especially with AO worker sharding.
- Lattice-based systems such as RoKoko are relevant for post-quantum succinct verification and
  structured sumcheck-style recursion, but require implementation maturity before live feed use.

## RoKoko Candidate

Paper:

```text
RoKoko: Lattice-based Succinct Arguments, a Committed Refinement
ePrint 2026/575
Michael Klooss, Russell W. F. Lai, Ngoc Khanh Nguyen, Michal Osadnik, Lorenzo Tucci
```

Why it matters to Paxiom:

- linear-time prover target,
- polylogarithmic communication and verifier complexity,
- roughly 200 KB proof-size claim in the public abstract,
- recursive split-and-fold proving structure,
- committed folding to reduce recursion rounds,
- recursive commitments for smaller communication,
- sumcheck-driven structured recursion,
- native support for tensor-structured relations, polynomial evaluation, and sumcheck relations.
- explicit path to R1CS through the functional-sumcheck starting relation.

How to classify it:

```text
not a Keccak shortcut
not a current production Paxiom backend
yes: candidate for post-quantum succinct receipts / aggregation backend
yes: candidate research backend for R1CS/sumcheck-shaped predicate proofs
yes: worth tracking for sumcheck-heavy proving and recursive aggregation
```

Paxiom integration target:

```text
EIP-1186 witness
  -> Keccak/RLP/MPT relation expressed as sumcheck/structured relation where possible
  -> RoKoko/lattice proof backend candidate
  -> compact subscriber receipt or recursive aggregate
```

Open engineering question:

Can the Ethereum inclusion relation be expressed in a shape that benefits from RoKoko's structured
recursion, or does bitwise Keccak still dominate enough that a STARK/zkVM remains the better first
backend?

Local PDF notes:

- Paxiom reviewed the local copy at `C:\Users\Kyle W. Luecke\Downloads\2026-575.pdf`.
- The paper reports RoKoko implemented in Rust.
- The concrete implementation targets almost-splitting power-of-two cyclotomic rings with
  `phi = 128` and modulus around `2^50`.
- The implementation uses incomplete NTT arithmetic, AVX-512-IFMA optimizations, BLAKE3
  Fiat-Shamir, and single-threaded experiments.
- For a PCS over `2^26` coefficients in `Z_q`, the paper reports a `214 KB` proof,
  `4.4 s` commit+prove time, and `8.6 ms` verification.
- The paper reports table values for RoKoko around `187 KB` proofs and millisecond verification
  in the tested PCS cases.
- The authors describe the library as ongoing work toward general-purpose lattice-based succinct
  arguments. Current caveats include same-process API, hard-coded semi-manual parameters, and
  future need for proof serialization/deserialization.

Paxiom implication:

RoKoko is more relevant than a pure aggregation layer because the paper explicitly mentions R1CS
support through the functional-sumcheck relation. However, the current implementation appears
PCS-oriented. The practical next step is a research adapter that tries to express one Paxiom relation
as a RoKoko-friendly sumcheck/R1CS instance, not an immediate replacement for the live slot0 lane.

## Production Ceremony / Transparent Backend

The current Groth16 setup is development-only. Before custody-adjacent or capital-routing usage,
Paxiom must choose one of:

- a real multi-party ceremony for production Groth16 predicate circuits,
- a transparent STARK/FRI backend for inclusion and/or predicates,
- a zkVM backend with reproducible verifier artifacts,
- a recursive wrapper that clearly identifies the trust assumptions of each inner proof.

Subscriber receipts must include:

- proof system id,
- verifier id,
- ceremony/transparency metadata,
- public input commitment,
- witness commitment,
- proof hash,
- aggregation root when available.

## Worker Split

Production workers are separated by stage:

```text
WitnessWorker
  fetches block/proof data, verifies MPT off-circuit, builds witness commitment

ProverWorker
  consumes witness, generates proof artifact

VerifierWorker
  verifies proof artifact and public inputs

ReceiptWorker
  emits signed feed item and optional AO commitment
```

The current staged slot0 pipeline implements this split locally. AO dispatch/retry state is
tracked by `ao-processes/zk-coordinator.lua`.

## Cache Boundary

`core/witness-cache.js` provides deterministic cache keys for stable witness fragments.

Safe to cache:

- ABI selectors,
- event topics,
- known storage slot identifiers,
- pool/account metadata,
- stable predicate configuration.

Do not cache as stable:

- block-specific account proof nodes,
- block-specific storage proof nodes,
- current storage values,
- state roots,
- block hashes.

## Benchmark Boundary

Run:

```sh
npm run zk:bench:slot0 -- --pool=<pool> --block=finalized --repeats=3
```

The benchmark reports latency by stage:

- witness,
- prove,
- verify,
- receipt.

This lets Paxiom measure:

```text
predicate x subject x block/window
```

and decide where AO sharding and caching matter most.

## Remaining Core Cryptography

Still to build:

- wire Keccacheck-backed Keccak to the normalized account/storage proof nodes,
- wire in-circuit RLP decoding to the normalized branch/extension/leaf node summaries,
- wire in-circuit Merkle Patricia path verification against the normalized trie keys,
- account proof inclusion under `state_root`,
- storage proof inclusion under `account.storageRoot`,
- composition with predicate circuits,
- recursive aggregation of many receipts.
- license-safe integration boundaries for AGPL/proprietary/open components.

Recommended sequence:

1. Install/provide an MPI-capable Expander worker runtime.
2. Test Expander on a synthetic Keccak-f batch and one Paxiom witness-derived batch.
3. Decode one RLP node inside the backend.
4. Prove one parent-child trie node hash/path check.
5. Prove the storage path against `account.storageHash`.
6. Prove the account path against `state_root`.
7. Compose account + storage EIP-1186 inclusion.
8. Compose with `uniswap_v3_slot0`.
9. Aggregate receipts by block/window.
