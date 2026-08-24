# Paxiom

Cross-chain state verification infrastructure. The goal is to answer questions
about Ethereum state — *what did storage slot X of contract Y hold at block N?* —
with a Merkle-verified answer and a signed evidence record, rather than a
trusted assertion from whoever ran the node.

**Status: working prototype.** The substrate layer verifies real Merkle-Patricia
proofs and the HTTP service tier is tested end to end. The zero-knowledge proving
layer is not built; the contracts target testnets; the HyperBEAM BLS device is
still a stub. This README tries to be precise about which is which — see
[What is and isn't built](#what-is-and-isnt-built).

```bash
npm install
npm test          # 159 tests across 6 suites
```

---

## How it fits together

```
                 ┌──────────────────────────────────────────┐
   HTTP clients  │  service tier  (services/*/server.mjs)    │
        │        │  x402 payment gate → handler → envelope   │
        └───────▶│  A-201 … A-205, catalog, compliance       │
                 └───────────────────┬──────────────────────┘
                                     │
                 ┌───────────────────▼──────────────────────┐
                 │  substrate  (load-network/)              │
                 │  fetch archived proofs → MPT-verify      │
                 │  against the block's stateRoot           │
                 └──────────────────────────────────────────┘
```

Every service response is wrapped in a signed envelope carrying the artifact, an
audit record, and the payment mode — so a consumer can check *what* was returned,
*who* signed it, and *whether* it was paid for, independently.

### The substrate — `load-network/`

Fetches archived Ethereum block, account, and storage proofs and verifies them
with `@ethereumjs/trie` against the block header's `stateRoot`. A returned value
is only accepted if the Merkle path actually proves it. This is the layer the
whole design rests on, and it is the part that most works.

### The service tier — `services/`

Eleven Node HTTP services, each a small `server.mjs` with its own test file:

| Service | What it answers |
|---|---|
| `slot-storage-proof` (A-201) | Proof of a single storage slot at a block |
| `sync-committee` (A-202) | Ethereum sync-committee signature verification |
| `cross-chain-message` (A-203) | Evidence attestation for a cross-chain message |
| `simulation` (A-204) | Deterministic simulation receipt |
| `historical-state` (A-205) | Verified historical storage state |
| `load-network` | Direct substrate access |
| `catalog` | Service discovery + pricing |
| `compliance` | Audit-record queries |
| `arb-engine`, `arb-runner`, `price-scanner` | The DEX-spread workload that exercises all of the above |

Shared machinery lives in `services/shared/`: `x402.mjs` (HTTP 402 payment
handshake), `envelope.mjs` (Ed25519 response signing over a canonical JSON hash),
`deployment.mjs` (strict-mode guards), `proof-archive.mjs`.

### Contracts — `*.sol`

`PaxiomPool` (LP / flash-credit pool), `PaxiomFlashLoan` (Aave flash-loan
arbitrage), `PaxiomOApp` (LayerZero opportunity broadcaster). Optimism Sepolia /
Base Sepolia. **These have no automated test coverage** and carry known
unresolved findings — see below.

### Ledger — `core/`

An account ledger built as a reducer over an append-only event log, with a replay
verifier: `npm run test:core` replays the log twice and asserts the state hashes
match. Self-contained; not yet wired to any service.

---

## Design decisions worth explaining

**Canonical-JSON hashing before signing.** `envelope.mjs` serializes with sorted
keys and recursive canonicalization before hashing, so two structurally identical
responses always produce the same hash regardless of key insertion order.
Signature verification is otherwise unreliable across runtimes.

**Fail closed at every guard.** Response signing throws if no key is configured
rather than emitting a placeholder. The x402 gate throws if `REQUIRE_X402=1` with
no facilitator URL rather than accepting any header. `assertNotStrictMode` refuses
fixture clients in strict deployments. Each of these replaced a permissive
fallback — see the audit section.

**The env is the ceiling for live transactions.**
`executable = profitable && liveTransactionsEnabled`, and `liveTransactionsEnabled`
can only be narrowed by a caller flag, never widened past `PAXIOM_ENABLE_LIVE_TX`.
A compromised or misconfigured UI cannot turn on live trading.

**Verification is separate from consumption.** The substrate returns verified
state *plus its witness*, so a downstream consumer can re-verify rather than
trusting the service. That's the property the whole design exists for.

---

## The audit

[`AUDIT_REPORT.md`](AUDIT_REPORT.md) is a security audit of this codebase,
covering the Solidity contracts, AO/Lua processes, Node services, and deploy
assets. It is deliberately unflattering and worth reading before the code.

Fixed since:

- **H-01** — `envelope.mjs` fell back to a literal `dev:<sha256>` string when no
  signing key was set. That value is publicly recomputable from the response
  body, so anyone could mint a valid-looking envelope. Signing is now mandatory
  and Ed25519.
- **H-02** — `requirePayment` returned `{verified: true}` for any request with a
  non-empty payment header when no facilitator URL was configured, making paid
  endpoints free. It now refuses to serve.

Still open, and the reason the contracts should not be treated as production:

- `PaxiomPool._lzReceive` has effectively no peer authentication — any
  LayerZero source can mark loans confirmed.
- `PaxiomFlashLoan` swaps with `amountOutMinimum: 0`, which is a sandwich-attack
  drain.
- The HyperBEAM BLS device (`hyperbeam/devices/.../dispatch.lua`) is a stub that
  returns a hardcoded body instead of reading the harness verdict. With
  `MOCK_DEVICE=1`, services will sign envelopes asserting `verified: true` for
  data nothing checked.
- Legacy top-level scripts duplicate `sdk/` and retain command-injection sinks
  that the `sdk/` copies fixed.

---

## What is and isn't built

| Component | State |
|---|---|
| MPT proof verification (`load-network/`) | Working, tested against fixtures and live |
| HTTP service tier + x402 + signed envelopes | Working, 79 tests |
| Account ledger + replay verifier (`core/`) | Working, not wired in |
| Solidity contracts | Deployed to testnet; **untested, known findings** |
| HyperBEAM BLS device | **Stub** — returns a hardcoded verdict |
| Recursive ZK proofs over consensus history | **Not built.** Design intent only |
| Mainnet anything | **No** |

The recursive-proof architecture in `docs/` and on the project site describes
where this is headed, not what runs today.

---

## Running it

```bash
npm install
npm test                        # all suites
npm run test:load-network       # substrate proof verification only
npm run test:services           # HTTP tier only

npm run service:catalog         # start the catalog service
npm run service:ui              # local product console (SIWE wallet login)
```

Configuration is environment-driven; see
[`deploy/env/paxiom.env.example`](deploy/env/paxiom.env.example). Two variables
matter most:

- `PAXIOM_RESPONSE_SIGNING_PRIVATE_KEY_PEM` — Ed25519 PKCS8 key. Services refuse
  to sign without it.
- `X402_FACILITATOR_URL` — required whenever `REQUIRE_X402=1`.

## Documentation

- [`docs/phase-0-gates.md`](docs/phase-0-gates.md) — acceptance criteria per gate
- [`docs/phase-1-service-catalog.md`](docs/phase-1-service-catalog.md) — service contracts
- [`docs/load-network-integration.md`](docs/load-network-integration.md) — substrate integration
- [`docs/hyperbeam-bringup.md`](docs/hyperbeam-bringup.md) — device bring-up
- [`AUDIT_REPORT.md`](AUDIT_REPORT.md) — security audit
