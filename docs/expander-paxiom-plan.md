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

Current local blocker:

```text
Expander executor build requires MPICH or OpenMPI.
This WSL environment currently has cargo but no mpiexec/mpirun, and mpi-sys fails during build.
```

Next steps:

1. Install MPICH/OpenMPI or run the worker on a machine/container that already has MPI.
2. Run Expander's small proof smoke test with `expander-exec`.
3. Build the circuit/witness adapter that consumes `.paxiom-runtime/expander-keccak-batch.json`.
4. Prove the 50-permutation Paxiom witness-derived batch.
5. Benchmark `50`, `512`, and `1024` permutation batches.
6. Decide whether Expander replaces Keccacheck as the primary Keccak backend.
