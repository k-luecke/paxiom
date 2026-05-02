# Expander Plan For Paxiom

Source reviewed:

```text
Introducing Expander: The Fastest GKR Proof System to Date
Polyhedra Network blog
May 2, 2024
```

Primary claim relevant to Paxiom:

```text
Expander can prove roughly 4500 Keccak-f permutations per second on an Apple M3 Max
and on an AMD 7950X3D-class x86 machine.
```

The blog also says:

- Expander combines GKR with polynomial commitments inspired by Orion and Brakedown.
- It avoids FFTs and works over arbitrary finite fields.
- The reported implementation uses the Mersenne prime `2^31 - 1` over an extension field.
- One Keccak-f permutation is compiled into roughly `400,000` gates.
- Peak memory is reported as roughly `16 MB` per Keccak, with `4000` Keccaks using about `63 GB`.
- They frame Ethereum MPT data inclusion as a direct target.

Local implementation scan:

```text
repo: https://github.com/PolyhedraZK/Expander
local clone: .paxiom-runtime/upstream/Expander
license: AGPL-3.0
```

## Paxiom Read

Expander is the most promising throughput target so far for live Ethereum inclusion.

Paxiom's current real witness for one Uniswap V3 slot0 storage inclusion needs about `50`
Keccak-f permutations. At the blog's reported throughput, the Keccak portion would be tiny:

```text
50 / 4500 ~= 0.011 seconds
```

That estimate does not include:

- building the Expander circuit/witness format,
- proving the Keccak-256 sponge relation around Keccak-f,
- RLP constraints,
- MPT path constraints,
- proof recursion/wrapping,
- integration overhead,
- license/commercial deployment decisions.

## AO Implication

Expander shifts AO from “try to make one proof cheap” to “keep machines full with batches.”

```text
many Paxiom inclusion witnesses
  -> extract Keccak-f permutation tasks
  -> batch by block/window/predicate
  -> prove in Expander workers
  -> return verified node-hash receipts
  -> compose with RLP/MPT receipts
```

If Expander performs near the public benchmark on Paxiom's workload, AO message latency should
not be the main bottleneck. The critical path becomes:

```text
RPC proof fetch
  + witness conversion into Expander circuit format
  + RLP/MPT proof layer
  + recursive receipt aggregation
```

## License Boundary

The public Expander repository is AGPL-3.0. That is workable for experiments, but Paxiom should
avoid silently vendoring it into proprietary subscriber infrastructure without deciding the license
strategy.

Reasonable first integration:

```text
Paxiom core
  -> external Expander worker process
  -> proof artifact / receipt
  -> Paxiom verifier adapter
```

This keeps the integration boundary explicit while we validate performance.

## Next Engineering Step

Implemented Paxiom-side batch generation:

```sh
npm run zk:batch:expander-keccak -- --witness=.paxiom-runtime/ethereum-inclusion-witness.json
```

This writes:

```text
.paxiom-runtime/expander-keccak-batch.json
```

The batch contains:

- account trie key Keccak,
- storage trie key Keccak,
- every account proof node Keccak,
- every storage proof node Keccak,
- Keccak-f input/output states for every sponge permutation.

For the current Uniswap V3 slot0 witness:

```text
hash tasks: 16
Keccak-f permutations: 50
```

Runtime check:

```sh
npm run zk:check:expander
```

Local smoke test:

```sh
npm run zk:smoke:expander
```

Current local status:

```text
Expander executor builds with the rootless OpenMPI/libclang setup in .paxiom-runtime/mpi.
The bundled small M31 circuit proves and verifies successfully.
The Paxiom GF2 adapter generates a valid Expander circuit/witness for real witness-derived
Keccak-f transitions from .paxiom-runtime/expander-keccak-batch.json.
```

Adapter command:

```sh
npm run zk:adapt:expander-keccak
```

Proof command:

```sh
npm run zk:prove:expander-keccak
```

The adapter supports deterministic chunks:

```sh
node sdk/generate-expander-keccak-adapter.cjs --offset=0 --count=1 --out-dir=.paxiom-runtime/expander-keccak-adapter-smoke
```

Local blocker found on this WSL host:

```text
The 50-transition monolithic M31 circuit is too large for the local WSL memory envelope.
The GF2 one-transition adapter circuit/witness validates, but Expander proof generation is blocked
locally: Raw PCS hits an illegal instruction in the GF2 prover path, while Orion PCS fails due a
missing/deserialization-failed GF2 SRS.
```

Next steps:

1. Run the GF2 adapter on an AVX-compatible Expander worker or provide the correct Orion GF2 SRS.
2. Prove all 50 witness-derived transitions as chunks, then aggregate receipts.
3. Benchmark `50`, `512`, and `1024` permutation batches on the worker target.
4. Decide whether Expander replaces Keccacheck as the primary Keccak backend.
