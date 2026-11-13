# Paxiom recursive sync-committee checkpoint

This subtree is a corrective, reviewable implementation of a narrow Ethereum consensus proof claim. It is intentionally separate from the historical Paxiom AO process.

The base SP1 program verifies a BLS12-381 Ethereum mainnet sync-committee aggregate over the SSZ root of an attested beacon header. The accumulator program verifies two compressed SP1 proofs inside SP1, enforces root continuity and fixed anchors, and emits a constant-length rolling checkpoint. It can also verify a prior accumulator proof plus a new base proof.

## Evidence status

| Property | Status | Evidence |
|---|---|---|
| Native BLS verification of two real mainnet headers | Demonstrated | Slots 14,814,118 and 14,814,119, each with 511/512 participants; positive and mutation tests pass |
| Base program compiles for SP1 RISC-V | Demonstrated | `cargo prove build` through the pinned SP1 6.3.1 build integration |
| Accumulator program compiles for SP1 RISC-V | Demonstrated | Same build, including calls to `verify_sp1_proof` |
| Base program executes in the SP1 zkVM | Not yet demonstrated | Local portable and native attempts exhausted the 5.7 GiB VM before emitting public values or a report; see `BENCHMARKS.md` |
| Compressed base proof generated and verified | Not yet demonstrated unless `artifacts/manifest.json` says otherwise | A compiled guest is not a proof artifact |
| Recursive compressed proof generated and verified | Not yet demonstrated unless `artifacts/manifest.json` says otherwise | Recursion source code is not evidence of a completed recursive proof |
| Ethereum light-client protocol/finality | Not implemented | No committee branch, rotation, finalized-header branch, or fork-choice rule |
| AO proof verification | Not implemented | AO is an authenticated checkpoint index only |

Read [SOUNDNESS.md](SOUNDNESS.md) and [CLAIMS.md](CLAIMS.md) before describing this project publicly. [REVIEWER_GUIDE.md](REVIEWER_GUIDE.md) maps each important check to the attack it prevents and the evidence a reviewer should inspect.

## What the base statement proves

For a fixed committee root, mainnet genesis validators root, and fork version, the base guest:

1. SSZ-hashes an attested `BeaconBlockHeader`.
2. Deserializes all 512 compressed BLS12-381 public keys and the G2 signature.
3. recomputes the `SyncCommittee` SSZ root, including its aggregate public key, and compares it to the trusted root;
4. aggregates only pubkeys selected by the 512-bit participation vector;
5. requires at least 342 participants;
6. computes the Ethereum sync-committee domain and signing root; and
7. checks the pairing equation for fast aggregate verification.

It commits a fixed 190-byte public-value record containing the parent and attested roots, slots, trust anchors, witness commitment, fork version, and participant count.

## Recursion design

The accumulator guest accepts either:

- two base proofs for the seed checkpoint; or
- one prior accumulator proof and one new base proof for an extension.

It verifies the inner compressed proofs with SP1's recursive verification syscall, binds each proof to the SHA-256 digest of its public values, checks program-key roles, enforces root continuity and invariant anchors, then commits a fixed 260-byte checkpoint. This is proof-carrying recursive composition. It is **not Nova-style folding**, despite the rolling state shape.

The expected program keys are committed as public values, not hard-coded. Every relying verifier must pin both key hashes. Failure to pin them is a self-selected-program soundness bug.

The accumulator encodes SP1's eight-word recursive vkey digest as eight little-endian `u32` values. AO checkpoint fields must use the CLI's `*_recursive_vkey_bytes` values. SP1's `bytes32()`/`*_vkey_bytes32` value is a different BN254-oriented representation used by on-chain verifiers; the two must not be substituted for one another.

## Quick verification

Requirements: Node.js 20+, Rust 1.93.0, SP1 6.3.1, and `protoc`.

```bash
node scripts/verify-fixture.mjs
cargo test -p paxiom-light-client-lib --features serde_json
cargo check -p paxiom-light-client-script
cargo run -p paxiom-light-client-script -- execute \
  --fixture fixtures/mainnet-14814119-14814120.json
cargo run -p paxiom-light-client-script -- vkeys --program update
cargo run -p paxiom-light-client-script -- vkeys --program accumulator
```

SP1 execution, key setup, and proof generation need substantially more memory than this local VM provides. On suitable hardware:

```bash
cargo run -p paxiom-light-client-script -- prove-base \
  --fixture fixtures/mainnet-14814119-14814120.json --index 0 \
  --output artifacts/proofs/base-14814118.bin

cargo run -p paxiom-light-client-script -- prove-seed \
  --fixture fixtures/mainnet-14814119-14814120.json \
  --output artifacts/proofs/checkpoint-2.bin
```

`extend` consumes a prior accumulator proof and a later fixture update. A proof cannot be extended with the second update in the bundled fixture because that update is already in the seed.

## Repository map

- `lib/`: no-std SSZ, BLS, public-value codecs, and transition checks.
- `program/`: base SP1 guest.
- `aggregate-program/`: recursive SP1 guest.
- `script/`: execute, prove, extend, verify, and vkey CLI.
- `fixtures/`: fixed real-mainnet input and provenance.
- `scripts/`: capture, fixture verification, and reproduction helpers.
- `artifacts/`: machine-readable evidence manifest and locally generated proofs.
- `../ao-processes/recursive-checkpoint.lua`: authenticated AO index, explicitly not a proof verifier.

## Correct application wording today

> Implemented and compiled SP1 6.3.1 base and recursive guest programs for fixed-committee Ethereum sync-committee verification; independently verified two real-mainnet BLS12-381 signatures and failure mutations in native Rust tests. Recursive proof generation and full Ethereum light-client finality/committee rotation are not yet demonstrated.

Do not say this is a full Ethereum light client, verifies finality, rotates committees, runs an archive node in AO, or is continuously autonomous.
