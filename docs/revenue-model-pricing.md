# Paxiom Revenue Model And Tiered Pricing

Paxiom sells scoped, authenticated access to verified Ethereum state predicates delivered
as subscriber-ready records with proof context and durable commitments.

It does not sell custody, execution, investment advice, arbitrary coprocessor compute, or
raw storage capacity.

## Pricing Dimensions

Each subscriber token should eventually encode:

- Predicate scope.
- Subject scope.
- Verification level.
- Freshness.
- Rate and volume limits.
- Historical depth.
- Expiration and contract tier.

These dimensions are the product. They should be represented in the token/account model
instead of handled manually in support threads.

## Tiers

### Public / Schema

Free, no auth.

Includes schema docs, predicate descriptions, `GET /health`, public sample records, API docs,
and proof corpus docs. No live production feed access.

### Developer

Suggested public price: $49/month after approval.

Includes all live public predicates, public subject catalog, `mpt_verified` finalized records,
1,000 requests/day, 5 requests/minute, and last 7 days of records.

### Pilot

Suggested price: $500-$2,000/month.

For 30-90 day scoped design partner trials. Includes negotiated predicate and subject scope,
`mpt_verified` plus AO-committed records when available, 25,000 requests/day, 30 days of history,
commitment lookup within scope, and direct support.

### Production

Suggested price: $3,000-$10,000/month, annual preferred.

Includes broader predicate and subject scope, production rate limits, archive since contract
start, commitment lookup, support, and API uptime targets.

### Enterprise / Custom Predicate

Suggested range: $50K-$250K+ annually, plus custom predicate fees.

Includes custom predicates, dedicated capacity, roadmap priority, higher verification-level
access, named technical support, and negotiated SLA.

## Custom Predicate Model

Custom predicates are the most leveraged revenue line because they expand the library.

- One-time engineering fee: $15K-$75K.
- Recurring access fee: Pilot, Production, or Enterprise tier.
- Predicate joins the library unless exclusivity is explicitly purchased.
- Exclusivity should be expensive enough that it is rare.

Decline or heavily price one-off predicates that will not become reusable product surface.

## Billing And Metering

Build toward:

- Token records keyed by token hash.
- Explicit scope fields for predicate, subject, verification level, freshness, rate limit,
  history depth, and expiration.
- Persisted request counters per token.
- Stripe subscriptions for Developer, Pilot, and Production.
- Direct invoice/SOW process for Enterprise.
- Optional USDC payments only once there are enough customers to justify the operational work.

## KPIs

Track weekly:

- Live predicates.
- Design partners.
- Paying customers.
- MRR/ARR.
- Pilot-to-production conversion.
- p50/p95 proof latency by predicate.
- Records committed to AO per week.

Ignore vanity metrics unless they clearly convert into customers or distribution.

## Near-Term Revenue Tasks

1. Publish pricing publicly for Public, Developer, Pilot, and Production.
2. Build token issuance and scope enforcement.
3. Add request metering.
4. Convert one design partner into a paid pilot.
5. Draft a Tier 4 statement of work.
6. Review pricing quarterly against real customer behavior.
