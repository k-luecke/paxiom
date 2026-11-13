# Operational architecture

The correct system boundary keeps mutable Ethereum node state off AO and Arweave.

```text
Reth or Erigon archive/full node
        |
        | JSON-RPC + Beacon REST
        v
bounded Rust witness extractor
        |
        | typed SSZ/BLS witness
        v
SP1 base prover --> SP1 recursive accumulator
        |                    |
        +------ proof + public values ------+
                                             v
                              Arweave immutable artifact
                                             |
                                             v
                              AO authenticated index/state
                                             |
                                             v
                             API/Supabase operational views
```

## Node layer

Run Erigon or Reth on a dedicated VM or bare-metal host with fast local NVMe/block storage and enough RAM. A hot node needs mutable databases, random I/O, long-running networking, peer discovery, and process supervision. AO process memory and Arweave transactions do not provide those semantics. Managed Supabase Edge Functions are also the wrong execution surface for a node. See the official [Erigon hardware guidance](https://docs.erigon.tech/get-started/hardware-requirements), [Reth storage modes](https://reth.rs/run/storage/pruning/), and [Supabase Edge Function limits](https://supabase.com/docs/guides/functions/limits).

Reth is the sensible Rust choice if language consistency matters. Rewriting Erigon in Rust would duplicate years of consensus-critical storage, networking, RPC, sync, and performance work without improving the proof statement.

## Witness/prover layer

The extractor should be deliberately small: fetch exact beacon objects, validate response consistency, canonicalize them into versioned fixtures, and pass only bounded data into SP1. The prover should never depend on Supabase as a consensus source.

## Durable artifact layer

Store immutable proof bytes, public values, ELF/vkey hashes, fixture digest, software versions, and benchmark metadata on Arweave. Large execution-node snapshots can also be published as chunked immutable artifacts, but publishing snapshots is not equivalent to running an archive node or making AO execute one.

## AO layer

AO tracks the latest accepted checkpoint, ancestry, proof transaction reference, and public anchors. The included Lua handler authorizes a verifier identity because no SP1 verifier is implemented in Lua. If trust minimization is required, replace that authority with an actually verified SP1 verifier in a supported execution environment; do not rename an attestation as verification. HyperBEAM's own documentation describes AO-Core as a protocol for distributed programs and HyperBEAM as an implementation; neither statement supplies an SP1 verifier for this process ([AO-Core introduction](https://hyperbeam.arweave.net/build/introduction/what-is-ao-core.html), [HyperBEAM introduction](https://hyperbeam.arweave.net/build/introduction/what-is-hyperbeam.html)).

## Supabase layer

Supabase is suitable for job metadata, status dashboards, user accounts, notifications, and cached query views. It should not host the execution client inside a managed Edge Function, should not be the proof truth anchor, and should not be the only copy of proof artifacts.
