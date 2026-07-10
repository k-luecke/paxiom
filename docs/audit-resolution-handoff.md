# Audit Resolution — Session Handoff (2026-05-05)

Compact context for resuming the multi-repo audit-resolution work in a fresh
session. Source of truth for finding text and locations is each repo's
`AUDIT_REPORT.md`.

## Repos in scope
- `k-luecke/paxiom` (default branch `main`)
- `k-luecke/bls-verifier` (default branch `master`)
- `k-luecke/zkfwdbld` (default branch `main`)
- `k-luecke/paxiom-static` (default branch `main`)

Locally: `/home/user/{paxiom,bls-verifier,zkfwdbld,paxiom-static}`

## Audit at a glance
181 findings across the 4 repos, dated 2026-05-05.

| Repo | C | H | M | L | I | Total |
|---|---|---|---|---|---|---|
| paxiom | 6 | 13 | 21 | 21 | 11 | 72 |
| bls-verifier | 3 | 6 | 9 | 8 | 6 | 32 |
| zkfwdbld | 3 | 7 | 14 | 11 | 9 | 44 |
| paxiom-static | 0 | 5 | 11 | 12 | 6 | 34 |
| **Total** | **12** | **31** | **55** | **52** | **32** | **181** |

(bls-verifier audit table lists 3 Critical though the executive summary says 2 — the table is authoritative; C-1 + C-2 share a function and were bundled into one PR.)

## Phases completed
1. **Phase 1** — Critical fixes (11 of 12; bls-verifier C-1+C-2 merged as one). All paxiom + bls-verifier + zkfwdbld Criticals closed.
2. **Phase 2** — Audit branches → default branches merged (paxiom #11, bls-verifier #9, zkfwdbld #4, paxiom-static #12 in their respective repos).
3. **Phase 3** — paxiom-static H-1..H-5 sanitization (founder PII scrub, work-branch link repointing, Phase 0 contradictions reconciled).
4. **Phase 4** — Branch hygiene attempted; **proxy 403 blocked tag pushes and branch deletes**. ~28 audit-fix branches still exist on remotes.
5. **Phase 5b** — All 165 remaining findings filed as GitHub issues with `audit-2026-05-05` label and `severity:{high,medium,low,info}` labels. Issue numbers documented per finding in commit messages.
6. **Phase 6** — Direct-apply phase resolved 25 PRs covering ~58 findings before the user corrected the pool architecture.
7. **Phase 7** — Corrected 5+1+1 panel pattern; 8 panels completed this turn.

## The corrected pool (5+1+1)

**Strict policy: no items get skipped without full panel review.**

Every audit finding — including positive observations and "no-action"
recommendations — runs through:

- **5 implementers** (parallel, `general-purpose` agents) — each reads the
  relevant files independently and proposes a fix or argues for no-action.
  Output is a unified diff or a defended position.
- **1 asshole** — brutal critic. Roasts every implementer's output. Looks
  for: scope creep, security theater, unsupported "best practice"
  hand-waving, lazy unanimity, freeloading agreement-without-reasoning.
  Does NOT pick a winner — destroys weak arguments so the moderator has
  clear ground to stand on.
- **1 moderator** — produces the final defensible decision. Weighs
  implementer consensus against the asshole's critique. Outputs the final
  diff or close-as-not-planned rationale.

### Cost per panel
~9–12 tool calls (5 parallel Agent calls + 1 Agent + 1 Agent + Read + Edit
+ commit + push + PR create + PR merge + issue close) and ~30–60 sec of
agent wall clock. ~10–15 panels per session is realistic before context
saturation.

### When asshole earns its keep
Repeatedly: every panel where implementers converged identically, the
asshole found a real bug (e.g. M-15: the unanimous patch had a privilege
escalation in `opts.liveTransactionsEnabled`, a lying `dryRun` field, and
buried a UI-needed signal). Without the asshole, panels rubber-stamp
identical-but-flawed work.

## The UI-configurability framing (operator direction)

The operator wants architectural ambiguities like wallet addresses, peer
addresses, treasury, kill-switches, etc. moved out of env vars and into the
operator UI. The panel discovered a coherent template that satisfies
this **without re-introducing the same security gap the audit flagged**:

### env-as-floor + UI-mutates-above-floor

- **env at startup**: still gates the root-of-trust (e.g. one admin wallet
  must exist via env; PAXIOM_ENABLE_LIVE_TX is the ceiling). Audit-true
  fail-closed semantics preserved.
- **UI post-auth**: an admin role (seeded from env) can mutate the runtime
  set via authenticated UI pages. Persists to `data/<thing>.json` with
  mode 0600, atomic tmp+rename, and an append-only audit log
  (`data/<thing>.audit.log` with prev/next hash chain).
- **env-locked admins / env-ceilings**: UI cannot escalate beyond env. It
  can extend (e.g. add more wallets, restrict the live-tx switch) but
  never raise the env-defined ceiling.
- **opts can only force OFF**: in-process per-request overrides may
  restrict, never expand, the effective state.

### Findings that fit this template

- **paxiom M-18** (wallet allowlist) — strict env path landed in PR #89;
  hybrid follow-up issue **paxiom#90** captures the UI surface.
- **paxiom M-15** (live-transactions kill-switch) — AND-gate landed in
  PR #91; hybrid follow-up issue **paxiom#92** captures the UI control.
- **paxiom H-10** (`setTreasury`/`setPeerEid` no timelock no event) —
  strong fit; treasury address exactly the kind of operator-managed
  config that should live in UI with a timelock workflow.
- **paxiom M-7** (`peerEid` change race) — UI surface for staged
  peer transitions.
- **paxiom M-16** (LayerZero options gas hardcoded) — UI-managed gas
  ceiling.
- **bls-verifier H-1** (MockX402 always Ok) — strictly env-required
  facilitator URL; UI can manage the runtime allowlist.

When implementing any of these, the panel prompt must include the
template explicitly so the implementers reach for it.

## What's closed (cumulative)

- **All 11 Critical PRs** (Phase 1) merged into audit branches and onward
  to default via Phase 2.
- **All 5 paxiom-static High PRs** (Phase 3).
- **25 direct-apply PRs** from Phase 6 (forgiven retroactively per user
  policy decision — they technically skipped the panel but are already on
  main; not worth reopening).
- **8 panel-resolved PRs/closures** from Phase 7 this turn:
  - paxiom-static: I-1, I-2, I-3, I-4, I-5, I-6 (#36, #37, #38, #39,
    #40, #41)
  - paxiom: M-18 (#42), M-15 (#39)

**Total findings closed: ~71 of 181 (~39%).**

## What's open

### Highs not yet panel-reviewed (24 + 5 paxiom-static-Hs already done = 24)

These are the highest-leverage targets for the next session — the panel
earns its cost most clearly here because the architectural ambiguity is
real. Many fit the env-floor + UI-mutates template:

| Repo | ID | Issue | UI-templatable? |
|---|---|---|---|
| paxiom | H-01 | #12 | response signing key — yes (signing config UI) |
| paxiom | H-02 | #13 | x402 facilitator URL — yes (UI config) |
| paxiom | H-03 | #14 | live-executor /signal HMAC — partially |
| paxiom | H-07 | #18 | LayerZero msg.value — partial (peer config UI) |
| paxiom | H-08 | #19 | LP-share inflation — no (Solidity-only) |
| paxiom | H-09 | #20 | liquidator/repay race — no (Solidity timing) |
| paxiom | H-10 | #21 | setTreasury/setPeerEid timelock — **yes, prime template** |
| paxiom | H-11 | #22 | pubkey-cache.json stale — no |
| paxiom | H-12 | #23 | top-level ao-poller fabricates opp — no |
| paxiom | H-13 | #24 | reentrancy surface — no (Solidity guard) |
| bls-verifier | H-1 | #10 | MockX402 — **yes, x402 facilitator UI** |
| bls-verifier | H-2 | #11 | sign_response stub — partial |
| bls-verifier | H-3 | #12 | Pubkey parse mask | no |
| bls-verifier | H-4 | #13 | CLI panics — no |
| bls-verifier | H-5 | #14 | C-FFI null checks — no |
| bls-verifier | H-6 | #15 | Cache no fork metadata — no |
| zkfwdbld | H-1 | #5 | demo-mode result propagation — partial (UI gating) |
| zkfwdbld | H-2 | #6 | wsl.exe shell injection — no |
| zkfwdbld | H-3 | #7 | path traversal — no |
| zkfwdbld | H-4 | #8 | Tauri capability — partial |
| zkfwdbld | H-5 | #9 | innerHTML markdown — no |
| zkfwdbld | H-6 | #10 | bytes_to_witness wraps — no |
| zkfwdbld | H-7 | #11 | scan_dom first-match — no |

### Mediums / Lows / Infos

~85 remaining open across the 4 repos. Most are well-bounded; the panel
will frequently produce small "no-action with documented rationale" or
single-PR fixes.

### Reopens still owed (5)
- paxiom #70 (I-04), #73 (I-07), #74 (I-08), #76 (I-09 — duplicate of L-14)
- (paxiom-static reopens #36-#41 are all closed via panel this turn)

### Follow-ups (architectural, not raw audit findings)
- **paxiom#90** — M-18 hybrid wallet allowlist (admin UI + persisted store)
- **paxiom#92** — M-15 hybrid live-tx control (admin UI + persisted store)

These two are siblings; they share the env-floor + UI-mutates pattern and
should be implemented together so they share storage helpers and audit-log
shape.

## Branch / tag hygiene still owed (proxy-blocked from this session)

The local proxy blocks tag pushes (HTTP 403) and branch delete pushes
(silently ignored as "Everything up-to-date"). User needs to do the
following from a credentialed shell:

1. **Push tags**: `audit-EYmjC-2026-05-05` exists locally on
   `paxiom`, `bls-verifier`, and `zkfwdbld`. Push with
   `git push origin audit-EYmjC-2026-05-05` from a real shell, or
   create a GitHub release per repo.
2. **Delete merged branches**: ~30 `audit-fix/*` branches on the four
   repos. Either via the GitHub UI's "Delete branch" button per merged
   PR, or enable
   `Settings → General → Pull Requests → Automatically delete head branches`
   in each repo for future merges.

## Resumption guide

When starting a fresh session:

1. Read this file first (`/home/user/audit-resolution-handoff.md`).
2. Re-read the four `AUDIT_REPORT.md` files for finding text + line refs.
3. Spawn the next 7-panel batch starting with the **paxiom Highs** that
   fit the UI-template (H-10 first — strongest fit). Use the panel prompt
   pattern below.
4. Per panel: 5 implementers in one message → 1 asshole → 1 moderator →
   apply → push → PR → merge → close issue.
5. When the panel produces UI-config recommendations, file them as
   follow-up issues with `audit-2026-05-05`, `follow-up`,
   `ui-configurability` labels. Reference issues #90 and #92 as the
   template anchors.

## Panel prompt template (working version)

For each finding:

```
Implementer #N of 5 in a 7-agent panel (5 implementers + 1 asshole + 1 moderator).

**Finding (<repo> <id>, severity <X>):** <quote audit text>
Audit recommendation: <quote>

**File(s):** <paths>

**Operator framing:** architectural ambiguities like wallet addresses,
peers, treasury, kill-switches should be set up from the UI rather than
baked into env vars. Pattern: env seeds bootstrap floor, UI mutates
above floor, opts can only force OFF.

**Task:** Read the file(s). Pick a path. ≤200 words. Diff if proposing.
```

Asshole prompt:

```
THE ASSHOLE — 7-agent panel <id>. Roast every implementer's proposal.
Be specific about scope creep, theatrical security, unsupported claims,
freeloading on prior implementers, the gap between "is technically
possible" and "actually matters here."

[5 proposals quoted]

Verdict: lean change, lean no-action, or "neither side made the case."
≤300 words.
```

Moderator prompt:

```
MODERATOR final verdict for <id>.

[Audit, implementer split, asshole verdict]

Your call: (a) close as not-planned with rationale, (b) ship change <X>,
(c) some synthesis. If (b)/(c), produce final diff. ≤200 words.
```

## Sharp edges to remember

- Implementer agents sometimes write to disk despite "do not modify"
  instructions. Always check `git status` after the implementer round
  before applying the moderator's final diff — the work may already be
  there.
- Agents occasionally fail with transient HTTP 403s on
  `mcp__github__issue_write`. Retry the single failing call.
- The proxy at `127.0.0.1:<port>/git/k-luecke/...` blocks tag pushes and
  branch deletes. Don't try to fix from inside the session.
- `npm test` from `/home/user/paxiom` fails on missing `viem` /
  `@ethereumjs/util` deps in this env. The actual sync-committee +
  compliance + (post-fix) ui tests run fine when invoked directly with
  the right env vars (`MOCK_DEVICE=1 PAXIOM_ALLOW_MOCK=1
  PAXIOM_ALLOWED_WALLETS=0x000...001`).
- `cargo test -p bls-device --lib` and `cargo test --lib` (zkfwdbld)
  both run cleanly.

## Files modified outside the per-finding work

- `/root/.claude/plans/let-s-get-a-plan-quiet-gem.md` — original cleanup
  plan from earlier in the session. Stale now; superseded by this doc.

## Final disposition this session

- 81 findings closed (71 audit findings + 2 follow-ups + various dupes).
- 100 audit findings still open + 2 follow-ups (#90, #92) tracking the
  UI-hybrid template.
- Next session: panel through the 24 Highs first, prioritizing
  UI-templatable ones (paxiom H-10, bls-verifier H-1, paxiom H-02).
