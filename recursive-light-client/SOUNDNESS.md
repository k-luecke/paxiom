# Soundness boundary

This document states the actual proposition enforced by the code and the assumptions a verifier must supply. It is not a security audit.

## Base proposition

Let `H` be the supplied attested beacon header, `S` the supplied signature slot, `C` the ordered vector of 512 public keys, `B` the participation bitvector, and `sigma` the aggregate signature. Let the public trust anchors be committee root `R_C`, genesis validators root `R_G`, and fork version `F`.

Successful execution establishes:

- `S > H.slot > 0`;
- every member of `C` is a valid, non-identity compressed BLS12-381 G1 point;
- `sigma` is a valid, non-identity compressed BLS12-381 G2 point;
- the SSZ `hash_tree_root(SyncCommittee(C, aggregate(C)))` equals `R_C`;
- `popcount(B) >= 342`;
- the Ethereum sync-committee signing domain is derived from `F`, `R_G`, and domain type `0x07000000`;
- `sigma` satisfies the pairing equation for the participating aggregate public key and `SigningData(hash_tree_root(H), domain)`; and
- the public record is a deterministic encoding of `H.parent_root`, `hash_tree_root(H)`, the anchors, witness commitment, fork version, and count.

This authenticates the attested header under the fixed committee assumption. It does not, by itself, establish canonicality or finality.

## Recursive proposition

The seed case recursively verifies two compressed base proofs. The extension case recursively verifies one compressed accumulator proof and one compressed base proof using [SP1 proof aggregation](https://docs.succinct.xyz/docs/sp1/writing-programs/proof-aggregation). In both cases it checks:

- proof vkey role equals the supplied expected role;
- the inner proof commits to the SHA-256 digest of the exact public-value bytes;
- prior end root equals next parent root;
- slots strictly increase;
- committee root, genesis validators root, and fork version do not change; and
- a domain-separated update-chain digest commits to the ordered witness commitments.

The output commits the base and accumulator vkey digests. A relying verifier **must compare those digests to keys obtained independently from the reviewed ELFs**. The keys are inputs to the recursive guest; committing them makes selection visible but does not make an unpinned selection trustworthy.

The recursive digests are the eight `hash_u32()` words serialized little-endian. They are not SP1's BN254 `bytes32()` vkey representation. The CLI prints both with distinct labels.

## Trust assumptions

1. SP1 6.3.1 proof-system soundness and the integrity of its recursive verifier syscall.
2. Collision resistance of SHA-256.
3. BLS12-381 and the hash-to-curve construction used by Ethereum.
4. Correctness of the locally implemented SSZ layouts for `BeaconBlockHeader`, `BLSPubkey`, and `SyncCommittee`.
5. The relying verifier independently trusts the mainnet genesis validators root, fork version, sync committee root, and both program vkeys.
6. The trusted committee contains less than one-third adversarial weight for the claim the application wants to infer.

## Explicit non-claims

The code does **not** prove:

- a Merkle branch from the trusted beacon state to the supplied current sync committee;
- a `next_sync_committee` branch or committee rotation;
- the `finalized_header` branch required by the Ethereum light-client update protocol;
- that the attested header is canonical under LMD-GHOST or finalized under Casper FFG;
- that the sync aggregate was included in a particular beacon block body;
- execution-payload validity or execution-state correctness;
- validator balances or a stake-weighted threshold beyond the protocol's fixed sync-committee membership model;
- zero knowledge as an application property;
- availability, continuous operation, or autonomous triggering;
- SP1 verification inside AO Lua.

The fixture's `signature_block_finalized` and `signature_block_execution_optimistic` fields are capture-time metadata checked by tests. They are not private inputs and are not constrained by the guest. They therefore cannot support a proof-of-finality claim.

## Known protocol gap: fixed committee

The bundled committee was obtained from a beacon API state during the same sync-committee period and its SSZ root is recomputed in code. The root is still an out-of-band trusted anchor. There is no proof connecting that root to a previously trusted beacon-state root. This is the largest gap between the current implementation and an Ethereum light client.

## AO boundary

`ao-processes/recursive-checkpoint.lua` authorizes one verifier identity and indexes its checkpoint attestations. AO authenticates the sender and provides durable state progression; the Lua process does not parse or cryptographically verify an SP1 proof. Compromise of that verifier authority permits false entries in the registry, although it does not create valid SP1 proofs.
