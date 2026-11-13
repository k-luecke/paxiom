# Claim ledger

Use the demonstrated column only when speaking about completed work. The final column is language that should be rejected in a resume or interview today.

| Area | Demonstrated | In progress / conditional | Do not claim |
|---|---|---|---|
| Ethereum data | Two fixed real-mainnet attested headers, slots 14,814,118–14,814,119, each signed by 511/512 members of a fixed trusted committee | Generalize fixture capture across periods | “Verifies Ethereum mainnet consensus continuously” |
| BLS12-381 | Native and guest-source fast aggregate verification with actual G1 aggregation, G2 hash-to-curve, and pairings | Proof artifact depends on successful SP1 proof generation | “AO performs BLS pairings” |
| SSZ | `BeaconBlockHeader`, `BLSPubkey`, and `SyncCommittee` roots | Add generalized indices/branches | “Full SSZ light-client update verification” |
| Recursion | Accumulator guest source calls SP1 recursive verification and compiles; transition logic is unit-tested | A recursive claim becomes demonstrated only after `checkpoint-2.bin` is generated and locally verified | “Nova folding,” “recursive proof deployed,” or “production recursion” without artifact evidence |
| Trusted anchor | Committee/genesis/fork/program anchors are explicit and committed | Add trusted-state inclusion and rotation | “Trustless committee discovery” |
| Finality | None in the proof statement | Add finalized-header and committee Merkle branches plus protocol-period rules | “Proves finalized Ethereum headers” |
| AO | Authenticated, monotonic checkpoint registry code and a matching tested JavaScript state model | Deployment and live message history | “AO verifies SP1” or “autonomous AO light client” |
| Archive node | Architecture separates node, prover, Arweave artifacts, and AO index | Operate a real Reth/Erigon node externally | “Erigon runs inside AO/Arweave/Supabase” |

## Current honest wording

The execution and proof gates below have **not** been reached on the recorded host. The strongest currently demonstrated wording is:

> Implemented and compiled SP1 6.3.1 base and recursive guest programs for fixed-committee Ethereum sync-committee verification; independently verified two real-mainnet BLS12-381 signatures and failure mutations in native Rust tests. Recursive proof generation and full Ethereum light-client finality/committee rotation are not yet demonstrated.

Do not replace “implemented and compiled” with “proved,” “executed in SP1,” “deployed,” or “continuously verifies.”

## Severity of remaining gaps

- **Major:** no committee inclusion/rotation proof. The system is fixed-committee, not a complete Ethereum light client.
- **Major:** no finalized-header branch or consensus fork-choice/finality proof. A valid sync-committee signature authenticates a header but does not prove canonical finality.
- **Major until artifact exists:** recursive guest code is not the same thing as a generated and verified recursive proof.
- **Moderate:** fixture committee provenance is API-derived and externally anchored rather than derived from a trusted state proof.
- **Moderate:** the AO registry trusts an external verifier authority and is not deployed by this deliverable.
- **Minor:** the accumulator is recursive proof composition, not a folding scheme. Use precise terminology.

## Resume wording gates

After successful zkVM execution (not yet reached) but before proof generation:

> Built and executed an SP1 guest implementing Ethereum sync-committee BLS12-381 verification over fixed mainnet vectors, with explicit SSZ and trust-anchor checks; implemented and compiled a recursive accumulator guest with continuity and program-key binding.

After a compressed base proof is saved and verified:

> Generated and locally verified an SP1 compressed proof for a real Ethereum mainnet sync-committee signature from a fixed trusted committee.

Only after a compressed accumulator proof is saved, hashed in `artifacts/manifest.json`, and independently reproduced:

> Recursively composed two verified SP1 Ethereum sync-committee header proofs into a constant-length rolling checkpoint and locally verified the resulting proof.

None of those gates justify “full Ethereum consensus verifier” or “Ethereum light client.”
