# Goldilocks Backend Scan

This note captures the local Goldilocks-field material found in `zkfwdbld` and Schemaguru,
and how it maps to Paxiom's live Ethereum proof roadmap.

## Source Found

Local repositories:

```text
/home/kyle_w_luecke/zkfwdbld
/mnt/c/Users/Kyle W. Luecke/Documents/New project
```

Relevant files:

- `src/fields.rs`
- `src/r1cs.rs`
- `src/witness_gen.rs`
- `src/lib.rs`
- `docs/proof_contract.md`
- `core/keccak256.mjs`
- `goldilocks.py`

The Windows `New project` tree is Schemaguru. Its Rust crate is still named `zkfwdbld`,
which matches the Rust/Wasm proof kernel lineage found in `/home/kyle_w_luecke/zkfwdbld`.

## Field

Both Rust trees define the standard 64-bit Goldilocks prime:

```text
p = 2^64 - 2^32 + 1
p = 18446744069414584321
```

The implementation uses `ark_ff`:

```rust
#[derive(MontConfig)]
#[modulus = "18446744069414584321"]
#[generator = "7"]
pub struct GoldilocksConfig;

pub type F = Fp64<MontBackend<GoldilocksConfig, 1>>;
```

The useful property for Paxiom is the field's large 2-adicity, which is friendly to FFT-heavy
proving systems and therefore relevant to high-throughput STARK-style proving.

Schemaguru also has a minimal Python reference:

```python
P = 0xFFFFFFFF00000001
```

## Existing Prover Shape

The existing Rust kernel currently has a sparse R1CS verifier over Goldilocks:

```text
(A * witness) * (B * witness) == (C * witness)
```

It also has:

- deterministic witness generation,
- witness serialization as 8-byte field limbs,
- JSON request dispatch through a Rust/Wasm boundary,
- AO-oriented proof request and result language,
- explicit proof-boundary documentation separating demo proofs from production claims.

That gives Paxiom a useful implementation reference for an AO-dispatched Goldilocks proving lane.

## Ethereum Keccak Reference

Schemaguru includes `core/keccak256.mjs`, a pure JavaScript implementation of Ethereum
Keccak-256. It is not circuit code, but it is useful because it lays out the exact algorithmic
pieces Paxiom must eventually prove:

- 24 Keccak-f[1600] rounds,
- theta, rho, pi, chi, and iota steps,
- 64-bit lane rotations,
- Ethereum padding byte `0x01`, not NIST SHA3 padding `0x06`,
- 136-byte rate for Keccak-256,
- 32-byte squeeze.

This file is a good correctness reference for a future constraint transcript, test vectors,
or a zkVM implementation target.

## What It Does Not Yet Give Paxiom

The scanned code does not contain an Ethereum storage proof verifier.

Missing for Paxiom's next target:

- Keccak inside the proof system, starting from the Schemaguru algorithm transcript,
- RLP decoding inside the proof system,
- Merkle Patricia Trie path verification,
- account trie inclusion under `state_root`,
- storage trie inclusion under `account.storageRoot`,
- composition with the current `uniswap_v3_slot0` predicate.

So this is not a drop-in replacement for the current Groth16 slot0 lane. It is a candidate
backend path for the expensive Ethereum-inclusion part of the proof.

## Best Use In Paxiom

Near term, keep the current split:

```text
EIP-1186/MPT verification outside circuit
  -> hash-bound into witness commitment
  -> Groth16 predicate proof for decoded slot0
  -> AO submission and subscriber receipt
```

Then add an experimental Goldilocks lane focused only on the hard part:

```text
EIP-1186 proof
  -> normalized account/storage trie witness
  -> Keccak/RLP/MPT constraints over Goldilocks-friendly backend
  -> public state_root/address/slot/value
  -> composed predicate receipt
```

## Candidate Interface

A Paxiom Goldilocks backend should expose this minimum interface:

```text
buildWitness(eip1186Proof, predicateInputs) -> witness bytes
prove(job, witness bytes) -> proof bytes + public inputs
verify(proof bytes, public inputs) -> boolean
receipt(job, proof, public inputs) -> paxiom.zk_predicate_proof.v1
```

The AO job contract should preserve the same commitment discipline already used by
`ao-processes/zk-coordinator.lua`:

- deterministic job id,
- subject and block binding,
- proof system id,
- witness commitment,
- receipt commitment,
- replayable public inputs.

## Current Experiment

Paxiom now has a reproducible Goldilocks/Keccak experiment:

```sh
npm run zk:goldilocks:keccak
```

The experiment performs four checks:

- validates fixed Ethereum Keccak vectors against Paxiom's local implementation and Schemaguru,
- represents the digests as Goldilocks-sized limbs,
- emits a bit-operation cost model for Keccak-f[1600] versus the current Groth16 slot0 lane,
- fetches a live EIP-1186 proof, verifies one trie root-node hash, then verifies the full
  account/storage proof with the existing MPT verifier.

This is still an experiment, not an in-circuit Keccak proof. Its job is to define the next
backend target and produce measured inputs for the Goldilocks/STARK or zkVM decision.

## Additional Reusable Ideas From Schemaguru/Zkfwdbld

The deeper scan found several useful optimization patterns. They do not remove the Keccak
constraint cost directly, but they can materially reduce end-to-end proving latency and repeated
work.

### Selector And Topic Caching

Schemaguru's contract modules cache common ABI selectors and event topics:

- `contracts/passive/abi_selectors.mjs`
- `contracts/core/semantic_state_specs.mjs`

For Paxiom, the equivalent is a predicate-specific cache of:

- storage slots,
- ABI selectors,
- event topic hashes,
- pool/account metadata,
- fixed trie-path components where safe,
- recurring witness fragments.

This avoids recomputing Keccak for stable protocol metadata and makes the live prover spend its
budget on block-specific state.

### Family Routing

Schemaguru's benchmark router separates deterministic families from harder symbolic families.
Paxiom should do the same for proof jobs:

```text
cheap deterministic predicate
  -> direct Groth16/Circom lane

Keccak/RLP/MPT-heavy predicate
  -> Goldilocks/STARK or zkVM lane

many receipts in same block/window
  -> recursive aggregation lane
```

This is where graph/TSP/Christofides-style thinking can help: route, batch, and aggregate proving
jobs so AO workers minimize duplicate witness work and return useful receipts first.

### Witness Shape Discipline

Schemaguru's active witness layer is explicit about observed state, expected state, unavailable
coordinates, and delta scores. Paxiom can borrow that discipline for capital feeds:

- publish what was proved,
- publish what was only committed,
- publish what was not observed,
- keep freshness and proof depth visible in every receipt.

That improves subscriber trust even before full in-circuit Ethereum inclusion lands.

### Goldilocks Throughput Assumption

`time_to_proof.py` and `projection_benchmarks.py` assume that Rust witness generation plus a
Goldilocks-friendly GPU prover can push very low latency for large constraint jobs. This is useful
as a target hypothesis, not yet a measured Paxiom result.

Paxiom should convert that hypothesis into measured benchmarks:

- one Keccak round trace,
- one full Keccak hash trace,
- one storage trie node,
- one full EIP-1186 account/storage proof,
- AO-sharded batches across predicate x subject x block.

### TSP / Curvature Heuristics

The symbolic TSP and curvature notebooks are useful for scheduling and search:

- choosing which proof jobs to run first,
- clustering jobs that share witness fragments,
- selecting aggregation trees,
- allocating AO workers to hot predicates.

They should not be used to approximate cryptographic verification. Ethereum inclusion proofs must
remain exact.

## Decision

Use `zkfwdbld` as a reference implementation for:

- Goldilocks field representation,
- sparse constraint representation,
- witness serialization,
- AO proof lifecycle language.

Use Schemaguru as a reference implementation for:

- the same Goldilocks Rust/Wasm kernel lineage,
- Ethereum Keccak-256 semantics,
- observation-to-claim-to-witness pipeline shape.

Do not port it directly into production Paxiom until the Ethereum inclusion circuit/backend
choice is made. The next cryptographic decision is whether Keccak/RLP/MPT should be built as:

- custom Goldilocks/STARK constraints,
- a zkVM program with a Goldilocks-ish proving backend,
- a Plonky2/Plonky3-style recursion layer,
- or a hybrid where Groth16 remains the small predicate layer and Goldilocks handles inclusion.
