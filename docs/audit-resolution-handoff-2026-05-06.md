# Audit Resolution — Session Handoff (2026-05-06)

Continuation of `docs/audit-resolution-handoff.md` (2026-05-05). This document
captures everything that landed during the 2026-05-06 session so a fresh
session can resume cleanly.

## Closure status

Cumulative across the four repos (paxiom, bls-verifier, zkfwdbld,
paxiom-static):

- All **12 Criticals** closed (Phase 1 + 2026-05-05).
- All **31 Highs** closed (paxiom H-01..H-13, bls-verifier H-1..H-6,
  zkfwdbld H-1..H-7, paxiom-static H-1..H-5).
- All **21 paxiom Mediums** closed.
- bls-verifier and zkfwdbld Mediums still open (next-priority queue).

Approximate cumulative: **~120 of 181 findings closed (~66%).**

## PRs landed this session

### paxiom (16)

| PR | Audit ID | Summary |
|---|---|---|
| #94 | H-10 | treasury timelock + admin events on PaxiomPool |
| #95 | H-02 | refuse `REQUIRE_X402=1` without `X402_FACILITATOR_URL` |
| #97 | H-01 | mandatory ed25519 response signing, no dev fallback |
| #99 | H-11 | remove stale `pubkey-cache.json` + scrub `/home/mk19/` defaults |
| #101 | H-12 | delete top-level `ao-poller.js`, scrub adjacent `/home/mk19/` leak |
| #103 | H-03 | HMAC + timestamp + nonce on live-executor `/signal` |
| #105 | H-07 | NatSpec runbook for `setPeerEid` + `requestLoan` msg.value |
| #107 | H-08 | `require(shares > 0)` on deposit + NatSpec analysis |
| #108 | H-09 | borrower-exclusive 60s grace after expiry |
| #109 | H-13 | `ReentrancyGuard` + CEI reorder of `_settleLoan` |
| #110 | M-04 + M-19 + M-21 | cluster |
| #111 | M-05 + M-09 + M-14 | fixture + log cluster |
| #112 | M-02 + M-10 + M-11 | clone + docs cluster |
| #113 | M-12 + M-13 | rename misleading service artifact types |
| #114 | M-06 + M-07 + M-08 + M-17 | executor + feeder cluster |
| #116 | M-16 | owner-set `lzOptions` on `PaxiomPool` + `PaxiomOApp` |

### bls-verifier (6)

| PR | Audit ID | Summary |
|---|---|---|
| #44 | H-1 | feature-gate `MockX402` + runtime `BLS_ALLOW_MOCK` floor |
| #46 | H-2 | mandatory ed25519 `sign_response`, replace SHA-256 stub |
| #48 | H-3 | explicit early-return loop for pubkey parse + lock test |
| #49 | H-4 | CLI returns error JSON instead of panicking |
| #50 | H-5 | null-pointer checks at C-FFI boundary, mark `unsafe extern` |
| #51 | H-6 | committee cache keyed by `(period, fork_version)` |

### zkfwdbld (7)

| PR | Audit ID | Summary |
|---|---|---|
| #50 | H-1 | demo-mode Proof-Result emits scrubbed body |
| #51 | H-2 | use `wsl.exe --cd` to eliminate shell injection |
| #52 | H-3 | decode + resolve + prefix-check path traversal in harness |
| #53 | H-4 | narrow Tauri capabilities + add CSP |
| #54 | H-5 | escape attribute-context in `escapeHtml` + audit `innerHTML` sites |
| #55 | H-6 | reject non-canonical witness u64 in `bytes_to_witness` |
| #56 | H-7 | `scan_dom` emits all matches per pattern, capped per pattern |

**Total this session: 29 PRs covering all remaining Highs + all paxiom Mediums.**

## Pattern observation: when the panel earns its cost

A clear bifurcation emerged this session:

- **Cluster-PR mechanical Mediums** — findings that are unambiguous
  quality nits (rename, fixture clone, log message, gas-table refresh,
  doc fix, etc.). Five implementers converge identically and the asshole
  has no real bite. paxiom #110, #111, #112, #113, #114 each bundled 3–4
  of these into one PR. The full 5+1+1 ceremony was overkill — a single
  implementer + a quick read-through is sufficient.
- **Architectural ambiguity** — anything where the audit recommendation
  has multiple defensible interpretations, or where the operator
  framing (env-floor + UI-mutates) needs to be applied. Run the full
  5+1+1: the asshole repeatedly caught defects the implementer
  consensus missed.

**Heuristic going forward:** if the audit recommendation is one
sentence and the diff is < 30 lines per file, cluster it.
If the recommendation is multi-paragraph or the change touches
state machines / auth / on-chain control flow, run the full panel.

## Asshole-caught defects (concrete examples)

The asshole earned its keep on several panels this session. Examples
worth remembering when staffing future panels:

- **paxiom H-08 (LP-share inflation):** four implementers proposed
  ERC4626-template virtual-shares fixes (`_decimalsOffset`,
  `_convertToShares`, totalAssets accounting). Asshole pointed out
  that `PaxiomPool` is **not an ERC4626 vault** — it's a single-asset
  custom share ledger, and dropping the OZ template wholesale would
  bring in storage layout that doesn't apply. The moderator's final
  fix was a minimal `require(shares > 0)` plus NatSpec — the audit's
  literal recommendation, not a template import.
- **paxiom H-13 (reentrancy surface):** unanimous patch added
  `nonReentrant` modifiers but reordered storage in a way that broke
  the inherited contract's storage layout. Asshole flagged the slot
  collision; moderator kept the modifier add but rejected the layout
  change.
- **paxiom H-09 (liquidator/repay race):** four of five implementers
  proposed a global pause on `repayLoan` during the rotation window.
  Asshole noted this is a borrower griefing surface — in-window loans
  get liquidated by `liquidateExpired` while the borrower can't pay.
  Moderator's fix: 60-second borrower-exclusive grace **after** expiry,
  not a global pause.
- **zkfwdbld H-1 (demo-mode result propagation):** initial proposals
  emitted the demo-derived proof body verbatim, indistinguishable from
  a real Proof-Result. Asshole flagged this as forensic falsification —
  a regulator reading the audit log later cannot tell demo from real.
  Moderator's fix: scrub the body and add an explicit `mode: "demo"`
  header so the artifact is non-confusable.
- **bls-verifier H-1 (MockX402 always Ok):** implementers reached for
  `std::env::var` directly. Asshole pointed out `bls-device` is a
  `no_std`-adjacent crate intended for HyperBEAM device contexts; pulling
  unrestricted env access in is not free. Moderator landed a
  feature-gate (`mock-x402`) + a separate runtime `BLS_ALLOW_MOCK=1`
  floor that's only consulted from the binary entrypoint, not the lib.

## Sharp edges that bit me

Practical session lessons worth saving:

- **Implementer agents writing to disk despite "do not modify"
  instructions.** Same warning as 2026-05-05, but bit me again on
  multiple panels. **Always run `git diff --stat` after every panel**
  before applying the moderator's diff — the work may already be on
  disk and applying again creates merge garbage.
- **`replace_all` recursion bug.** On paxiom H-13, an Edit using
  `replace_all` on `lzOptions = lzOptions` looped (the new string
  contained the old). Use a longer-context `old_string` or a sed
  pattern with anchors. Better still: prefer `Edit` without
  `replace_all` and target unique surrounding context.
- **Missing `setupResponseSigningKey` on three service tests
  post-H-01.** PR #97 made the signing key mandatory at module load
  in three services (sync-committee, compliance, cross-chain-message).
  Their existing test files imported the modules, which then threw on
  load. Fix: each test file needs the same
  `setupResponseSigningKey()` shim that the integration test uses.
  When landing a "fail-closed at module load" change, grep for every
  importer and add the shim — don't trust `npm test` to surface it
  because the test runner may already be in a partial state.

## Follow-up cluster (env-floor + UI-mutates siblings)

The 7-agent panel's "operator framing" produced a coherent cluster of
sibling follow-ups during this session. They share storage helpers
(`data/<thing>.json` mode 0600 + atomic tmp+rename + append-only
audit log with prev/next hash chain) and should land on a single
foundation rather than each implementing the persistence layer
separately:

| Issue | Repo | Summary |
|---|---|---|
| #90 | paxiom | M-18 hybrid wallet allowlist (env-seeds-admin + UI-manages-additions) |
| #92 | paxiom | M-15 authed UI control for `liveTransactionsEnabled` |
| #96 | paxiom | H-02 x402 facilitator runtime allowlist UI |
| #98 | paxiom | H-01 response signing JWKS + rotation + signing-config UI |
| #100 | paxiom | H-11 SDK pubkey cache period-keyed (quality, not template) |
| #102 | paxiom | H-12 `ao-poller.js` lazy wallet load (quality) |
| #104 | paxiom | H-03 extract `verifySignal` to testable module + tests (quality) |
| #106 | paxiom | H-07 peer-config UI: drain-then-update workflow for `setPeerEid` |
| #115 | paxiom | M-03 compliance log per-line signing + Merkle checkpoint |
| #45 | bls-verifier | H-1 production `HttpX402` client per Coinbase facilitator spec |
| #47 | bls-verifier | H-2 TEE-bound device signing key + operator UI rotation (sibling of paxiom #98) |

The four marked as "env-floor + UI-mutates siblings" — paxiom
#90/#92/#96/#98/#106 + bls-verifier #47 — should be implemented as a
single cluster so they share the persistence + audit-log helpers.

## Resumption guide

Next session priorities, in order:

1. **bls-verifier Mediums** (M-1, M-3..M-9, all open). Most are
   well-bounded Rust quality fixes: cluster-PR-able. Run a
   single-implementer pass with quick asshole spot-checks rather than
   the full 5+1+1.
2. **zkfwdbld Mediums** (M-2..M-12, M-14, all open). Mix of WSL
   harness, Rust internals, and Tauri-frontend nits. Same triage:
   cluster the mechanical ones, full panel only on the architectural
   ones.
3. **All Lows + Infos across all four repos** (~85 still open). Mostly
   cluster-PR territory.
4. **Follow-up cluster implementation** — only after the audit findings
   are at zero. The cluster needs the operator's design call on the
   shared storage shape; don't start without it.

When starting: read `docs/audit-resolution-handoff.md` (2026-05-05)
first for the panel pattern and architectural framing, then this file
for the deltas.

## Branch / tag hygiene still owed

Same proxy-blocked items as 2026-05-05 carry forward:

- Push tag `audit-EYmjC-2026-05-05` on paxiom, bls-verifier, zkfwdbld
  from a credentialed shell.
- Delete merged `audit-fix/*` branches across the four repos via the
  GitHub UI per merged PR (the four-repo total is now ~60+ stale
  branches; enabling
  `Settings → General → Pull Requests → Automatically delete head
  branches` per repo is the durable fix).

## Final disposition this session

- 29 PRs merged covering all remaining Highs (24) + all paxiom
  Mediums (16 across 6 PRs).
- 11 follow-up issues filed (9 paxiom, 2 bls-verifier).
- ~120 of 181 findings closed cumulatively (~66%).
- Next session: start on bls-verifier + zkfwdbld Mediums.
