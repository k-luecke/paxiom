# Reviewer guide

This is the fastest path for a skeptical ZK reviewer.

## Twenty-minute review

1. Read `SOUNDNESS.md`; note the fixed-committee and no-finality boundary.
2. Inspect `lib/src/lib.rs::verify_update` for SSZ, threshold, domain, and pairing checks.
3. Inspect `program/src/main.rs` to confirm the same function executes in the guest.
4. Inspect `aggregate-program/src/main.rs` for inner proof verification, vkey roles, public-value digests, continuity, and anchors.
5. Run `node scripts/verify-fixture.mjs` and the Rust tests.
6. Check `artifacts/manifest.json`. Treat every `pending` or `not-generated` entry as absent evidence.
7. Inspect `ao-processes/recursive-checkpoint.lua` and confirm it says `verifies_sp1_in_lua = false`.

## Constraint-to-attack map

| Check | Property enforced | Attack if omitted | Negative evidence |
|---|---|---|---|
| Parent SSZ root equals `attested_header.parent_root` | Exact parent slot/root transition | Invent a parent header or assume no skipped slots | Mutated parent header/root |
| Canonical SSZ attested-header root is signed | All header fields authenticated | Change state/body/proposer while retaining a valid parent signature | Mutated state root |
| 512 valid non-identity G1 points | Well-formed fixed committee | Malformed/short committee or exceptional points | Missing member and anchor mutation |
| Recomputed `SyncCommittee` root | Ordered pubkeys bound to trusted anchor | Substitute an attacker committee | Trusted-root mutation |
| Participation bitvector and `>=342` | Signer selection and supermajority | Claim non-signers or accept a minority | Bit mutation and 341-member vector |
| Mainnet domain and fork version | Network/fork replay separation | Replay a signature under another domain | Fork mutation |
| Pairing equation | BLS fast aggregate validity | Accept arbitrary aggregate signatures | Signature and message mutations |
| Recursive public-value SHA-256 | Inner proof bound to parsed bytes | Verify one statement and parse another | Enforced directly by SP1 syscall input |
| Recursive vkey role check | Only reviewed base/accumulator programs | Feed a proof from a different program | Program keys committed for external pinning |
| Root continuity | Ordered header chain | Compose unrelated valid signatures | Native transition unit test |
| Fixed anchors across recursion | One trust domain per checkpoint | Switch committee/network/fork mid-chain | Native transition unit test |
| AO sender authorization | Registry accepts one verifier authority | Any sender asserts `verified=true` | Five JavaScript registry tests |

## Questions the author must be able to answer

1. Why does the sync aggregate sign the attested header root rather than the signature block header?
2. Why is an explicit parent header necessary when Ethereum can have missed slots?
3. Why is 342 the first integer above two-thirds of 512?
4. What proof-of-possession assumption makes fast aggregate verification safe for distinct validator keys?
5. How is `hash_tree_root(BeaconBlockHeader)` laid out for five fields?
6. Why must the relying verifier pin vkeys even though the accumulator commits them?
7. What is the distinction between SP1 recursive composition and Nova folding?
8. Why does a valid sync-committee signature not establish canonical finality?
9. What branch is needed to trust a new sync committee from a prior state root?
10. Why is the AO registry still trusted even if its state is durable and its sender is authenticated?

If those answers are not fluent, the repository is useful implementation evidence but not yet evidence of senior-level conceptual ownership.
