# Paxiom Go-To-Market And Fundraising Playbook

This is the internal operating direction for Paxiom. The public site should expose the product,
pricing, proof levels, and pilot funnel. This document can stay more candid.

## Stage Assessment

Paxiom has working code for MPT-verified Ethereum storage proofs, a Uniswap V3 `slot0`
decoder, a feed API, commitment lookup, and a stable `paxiom.feed.v1` record shape.
The product wedge is verified Ethereum predicates as subscriber feeds.

The current gaps are commercial: paying customers, named design partners, public production
deployment, and a wider predicate library. The next year should convert those gaps into
traction instead of expanding the story too broadly.

## Narrative Spine

1. Most market infrastructure trusts what an RPC, hosted indexer, or relay says Ethereum
   state was at a block.
2. Paxiom turns Ethereum state into proof-labeled records subscribers can verify, archive,
   and replay predicate by predicate.
3. The predicate library compounds through protocol storage layouts, decoders, proof
   adapters, historical commitments, and integrations.

Customers care most about the first two sentences. Investors care most about the third.
Grant evaluators care about all three plus the trust-boundary roadmap:
`mpt_verified` now, AO-committed next, recursive aggregation later, beaconless proof depth
eventually.

## Positioning

Paxiom should not pitch itself as a generic coprocessor, oracle network, subgraph, or archive
node provider.

- Axiom: on-chain query callbacks for smart contracts. Paxiom: off-chain subscriber feeds
  for trading, risk, monitoring, audit, and settlement systems.
- Brevis and zkVM systems: general-purpose verifiable compute. Paxiom: curated predicates
  packaged as a product.
- Herodotus and storage-proof middleware: composable proofs for contracts. Paxiom: decoded,
  contextualized records for off-chain consumers.
- Lagrange: SQL-style/query infrastructure. Paxiom: answers, not a broad query interface.
- Chainlink/Pyth: fast reported oracle values. Paxiom: proof-labeled Ethereum state facts.
- Subgraphs/archive nodes: broad queryability/control. Paxiom: evidence around specific
  facts that matter.

## Developer Marketing

The audience is small and technical. The channel mix should be:

- Technical posts every 2-4 weeks.
- Short demo videos showing proof generation, verification, and commitment lookup.
- Predicate-of-the-week posts whenever a new predicate ships.
- Public changelog updates.
- Targeted presence at ETHDenver, ETHCC, Devconnect, EthGlobal, AO/Arweave channels,
  EF/L2 ecosystem communities, and proof-system communities.

Avoid token speculation, fake partner logos, and generic AI-style thought leadership.

## Design Partner Motion

Target 2-3 design partners before broad fundraising.

Priority targets:

1. Lending protocol risk teams.
2. Liquidation searchers and MEV teams.
3. Risk-monitoring vendors.
4. Bridges and settlement systems.
5. Custody/compliance providers.
6. Solver and intent networks.

The first pilot should be one predicate, one use case, 30-60 days, and a short letter
agreement. Free is acceptable for the first few if the feedback loop and reference value
are real. After that, charge.

## Fundraising Ladder

First aim for grants and ecosystem funding: EF ESP, Arbitrum, Optimism RetroPGF, Base,
AO/Arweave, RISC Zero/Boundless, and Gitcoin-style public goods rounds.

Then aim for a focused angel/pre-seed round once there are design partner letters or
early paid pilots. A realistic target is $500K-$1M on a SAFE, with milestones around
predicate count, production feed deployment, and paid subscribers.

Seed-scale fundraising should wait for paying customers, a decision-grade predicate
library, a production feed, named hires or a co-founder, and public benchmarks.

## Pitch Deck

Use a ten-slide deck:

1. Title.
2. Problem: state is reported, not proved.
3. Insight: predicates are the product.
4. What is live.
5. Moat.
6. Competition.
7. GTM.
8. Roadmap.
9. Ask and milestones.
10. Founder story.

Do not include token economics, fake logos, or giant TAM theater.

## 12-Month Milestones

Months 1-3:

- Land 2 unpaid design partners.
- Ship 2 new predicates beyond `storage_equals` and `uniswap_v3_slot0`.
- Publish one technical post and one short demo video.
- Apply to EF, Arbitrum, Base, AO, and related grants.
- Publish public latency benchmarks.

Months 4-6:

- Convert one design partner into a paid pilot.
- Ship two more predicates, including one decision-grade predicate.
- Start focused angel/pre-seed conversations.
- Speak at one relevant event.

Months 7-12:

- Close pre-seed or grants sufficient for runway.
- Hire cryptography/backend depth.
- Reach 2-3 paying subscribers.
- Commit records to AO/Arweave by default.
- Grow the predicate library toward 8+ live predicates with 3 decision-grade.

## Immediate 30 Days

1. Keep the homepage latency benchmark current.
2. Identify 10 design partner targets and send personalized outreach.
3. Apply to EF ESP and two ecosystem grants.
4. Publish one technical long-form post.
5. Ship one new predicate.
6. Keep public positioning on `where-paxiom-fits.html`, not adversarial oracle copy.
7. Surface pricing, predicate roadmap, and benchmarks in README/site docs.
