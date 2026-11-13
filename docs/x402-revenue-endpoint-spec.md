# Paxiom x402 Revenue Endpoint Specification

Date: 2026-05-03
Status: Implementation draft, first service wiring applied
Primary candidate endpoint: `POST /v1/sync-committee/verify`
Primary codebase: `/home/kyle_w_luecke/paxiom-ops-wt`
Related primitive repo: `/home/kyle_w_luecke/projects/bls-verifier`

## 0. Executive Summary

Paxiom is close to a live x402 endpoint. After the 2026-05-03 implementation pass, the service has real x402 server-side payment enforcement wired through the official middleware, but it still needs a funded client-side Base Sepolia payment rehearsal before it should be called revenue-live.

The closest candidate is Service A-202, Sync Committee Verification. It already has an HTTP server, request validation, a health endpoint, mock/subprocess/HyperBEAM dispatch modes, and operator evidence for a real Ethereum mainnet slot returning `verified: true`.

The old blocking gap was payment enforcement. The previous service only checked whether a payment-looking header existed. That stub has now been replaced by official x402 resource-server middleware:

- unpaid requests return `402` with `PAYMENT-REQUIRED`
- paid requests are verified by the hosted facilitator before dispatch
- the device work runs only after payment verification
- settlement happens before the paid JSON response is released
- `REQUIRE_X402=1` refuses to run with `MOCK_DEVICE=1`
- MCP metadata is exposed through public discovery endpoints
- local durable evidence packets are written for computation and settlement paths

What remains is not conceptual plumbing; it is the live rehearsal:

1. configure a real receiving wallet
2. fund a Base Sepolia test client with USDC
3. produce a valid `PAYMENT-SIGNATURE`
4. observe facilitator `/verify`
5. run the subprocess verifier
6. observe facilitator `/settle`
7. capture the payment response and evidence packet

Recommended milestone sequence:

1. **M0 / Paid-shape endpoint:** done locally. Official x402 middleware returns a hosted-facilitator `402`; mock output is non-billable by construction.
2. **M1 / Base Sepolia revenue rehearsal:** next. Use `$0.001`, hosted facilitator, real signed client payment, and subprocess verifier.
3. **M2 / Base mainnet pilot:** `$0.01`, hosted facilitator, subprocess verifier, public HTTPS endpoint, production Node runtime.
4. **M3 / Paxiom-grade endpoint:** HyperBEAM-hosted device, AO/Arweave evidence publication, monitoring, and an end-to-end replay story.

Estimated effort:

- **Base Sepolia paid rehearsal:** 0.5-1 focused day once wallet/funding are ready.
- **Public revenue-worthy endpoint:** 2-5 days if deployment infrastructure is already available.
- **Differentiated Paxiom endpoint with evidence/replay posture:** 2-4 weeks, mostly HyperBEAM registration, AO evidence publication, and monitoring.

## 1. Current State

### 1.1 Existing Service

File:

```text
/home/kyle_w_luecke/paxiom-ops-wt/services/sync-committee/server.mjs
```

Current routes:

```text
GET  /healthz
POST /v1/sync-committee/verify
GET  /mcp/tools.json
GET  /mcp/paxiom-sync-committee.json
```

Current behavior:

- Parses JSON body.
- Validates request shape via `schema.mjs`.
- Dispatches to one of:
  - `MOCK_DEVICE=1`
  - `BLS_DEVICE_VIA_SUBPROCESS=1`
  - default HyperBEAM dispatch URL
- Echoes an AO message id through `X-PAXIOM-RESPONSE-CORRELATION`.
- Emits local durable evidence packets unless `DISABLE_SYNC_COMMITTEE_EVIDENCE=1`.
- Protects `POST /v1/sync-committee/verify` with official x402 middleware when `REQUIRE_X402=1`.

The previous stub behavior was:

```js
const paymentHeader = req.headers['x-payment'] || '';
if (process.env.REQUIRE_X402 === '1' && !paymentHeader) {
  res.writeHead(402);
  res.end();
  return;
}
```

That code has been removed from the service. The remaining live-revenue task is to exercise the official middleware with a funded x402 client on Base Sepolia, then repeat on Base mainnet.

### 1.2 Existing Evidence

File:

```text
/home/kyle_w_luecke/paxiom-ops-wt/hyperbeam/bringup/evidence/gate-s02-20260503T010547Z.json
```

Evidence result:

- `slot`: `14245526`
- `verified`: `true`
- `primitive_return_code`: `1`
- `participating`: `510`
- `committee_size`: `512`
- `ao_message_id`: currently mock-shaped

Interpretation:

The sync-committee primitive is the best first paid endpoint because it has real verification evidence already. It is not the highest-value eventual product, but it is the fastest way to prove the x402 payment loop.

### 1.3 Current x402 State In Primitive Repo

File:

```text
/home/kyle_w_luecke/projects/bls-verifier/bls-device/src/x402.rs
```

Current state:

- `X402Verifier` trait exists.
- `MockX402` exists.
- Real facilitator verifier is explicitly TODO.

Docs confirm:

```text
/home/kyle_w_luecke/projects/bls-verifier/docs/O-702-bls-device-runbook.md
```

Summary:

The pipeline has a payment-verification stage, but the live implementation is mocked. This is good architecture shape, but not revenue capability.

## 2. Protocol Facts To Implement

Sources:

- x402 Client/Server: https://docs.x402.org/core-concepts/client-server
- x402 Facilitator: https://docs.x402.org/core-concepts/facilitator
- x402 Seller Quickstart: https://docs.x402.org/getting-started/quickstart-for-sellers
- x402 Network and Token Support: https://docs.x402.org/core-concepts/network-and-token-support
- x402 Payment-Identifier extension: https://docs.x402.org/extensions/payment-identifier
- x402 Signed Offers and Receipts: https://docs.x402.org/extensions/offer-receipt

### 2.1 Header Names

Current docs describe:

- Server returns `402 Payment Required`.
- `402` response includes `PAYMENT-REQUIRED` header.
- Client retries request with `PAYMENT-SIGNATURE` header.
- Server returns final response with `PAYMENT-RESPONSE` header.

Spec decision:

- Implement current documented headers first:
  - `PAYMENT-SIGNATURE`
  - `PAYMENT-REQUIRED`
  - `PAYMENT-RESPONSE`
- Do not alias legacy `X-PAYMENT`; it adds protocol surface without helping the pilot.
- Production must fail closed unless `PAYMENT-SIGNATURE` is present and facilitator verification succeeds.

### 2.2 Payment Flow

Required server flow:

1. Client sends unpaid request to protected endpoint.
2. Server returns `402 Payment Required`.
3. `402` includes payment requirements in body and/or `PAYMENT-REQUIRED` header.
4. Client creates signed payment payload.
5. Client retries same request with `PAYMENT-SIGNATURE`.
6. Server calls facilitator `/verify` with:
   - payment payload
   - selected payment details
   - route requirements
7. If facilitator verification fails:
   - return `402`
   - do not run expensive verifier
   - do not return proof result
8. If verification succeeds:
   - run service work
   - call facilitator `/settle`
9. If settlement succeeds:
   - return `200`
   - include normal service response
   - include `PAYMENT-RESPONSE` header
10. If settlement fails:
   - return `402` or `502` depending on failure class
   - do not treat request as paid
   - do not leak premium result unless policy explicitly allows post-verify/pre-settle work leakage

### 2.3 Recommended Scheme

For A-202 fixed-price verification:

```text
scheme: exact
network: eip155:84532 for testnet
network: eip155:8453 for Base mainnet
asset: USDC
```

Why `exact`:

- The cost is known before work begins.
- It is the simplest x402 scheme.
- It avoids variable settlement logic.
- It is appropriate for fixed-price proof/attestation endpoints.

Use `upto` later for variable-cost endpoints such as:

- S.03 historical state queries with variable proof size
- simulation-as-a-service
- private route search with variable search cost

### 2.4 Network Progression

Development:

```text
facilitator: https://x402.org/facilitator
network: eip155:84532
token: Base Sepolia USDC
```

Mainnet:

```text
facilitator: production facilitator supporting Base
network: eip155:8453
token: Base USDC
```

Important:

The default `x402.org/facilitator` is for testnet/development. Mainnet requires choosing a production facilitator or running one.

### 2.5 Token Details

x402 docs list Base USDC as:

```text
network: eip155:8453
token: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
decimals: 6
transfer method: EIP-3009
```

Base Sepolia USDC:

```text
network: eip155:84532
token: 0x036CbD53842c5426634e7929541eC2318f3dCF7e
decimals: 6
transfer method: EIP-3009
```

## 3. Product Scope

### 3.1 First Sellable Endpoint

Use:

```http
POST /v1/sync-committee/verify
```

Reason:

- Already exists.
- Already has request validation.
- Already has tests.
- Already has real mainnet verification evidence.
- Lower complexity than S.03.
- Good first product to prove paid agent-callable verification.

Do not start with S.03 for first revenue. S.03 is more valuable, but it still needs archive-node witness retrieval, proof-packet schema, and replay evidence.

### 3.2 First Product Description

Name:

```text
Paxiom Sync Committee Verification
```

Short description:

```text
Paid verification that an Ethereum sync committee signed a supplied header root for a given slot.
```

Machine-facing description:

```text
Given a slot, block root, parent root, sync committee bitfield, and aggregate BLS signature, return a verification result, participation count, signing root, fork version, platform signature, and evidence reference.
```

Human-facing value:

```text
Agents and services can buy a small, verifiable Ethereum consensus attestation without integrating the Rust verifier directly.
```

What it is not:

- Not yet S.03 historical state.
- Not yet a generalized coprocessor.
- Not yet private arbitrage alpha.
- Not a proof marketplace.
- Not a replacement for Ethereum consensus clients.

### 3.3 Pricing

Recommended testnet price:

```text
$0.001
```

Recommended first mainnet live price:

```text
$0.01
```

Alternative first live price:

```text
$0.05
```

Reasoning:

- A-202's first customer is Paxiom's own clearing layer, which needs verified Ethereum consensus attestations before settling cross-chain obligations.
- External agents and services are secondary buyers when they want a signed, replayable attestation without integrating BLS verification.
- The low pilot price encourages testing by agents while proving the receiving-wallet, facilitator, settlement, and evidence path.
- Higher-value pricing belongs to S.03, private feeds, and cross-chain attestations.

Do not optimize first price for margin before the pilot economics are measured. Optimize it for:

- successful paid calls
- proof of settlement
- clean public documentation
- discoverability
- evidence/audit pattern

### 3.4 Revenue Definition

There are three different "revenue" states:

1. **Protocol revenue:** a real x402 payment settles to Paxiom's wallet.
2. **Product revenue:** an outside caller pays because they wanted the result.
3. **Thesis revenue:** paid usage validates Paxiom's agent-native verified-claims thesis.

The first milestone only needs protocol revenue. The real goal is repeatable product revenue from Paxiom's own clearing layer and external buyers that need signed attestations.

## 4. Implementation Architecture

### 4.1 Recommended File Layout

Add:

```text
services/sync-committee/x402-config.mjs
services/sync-committee/x402-gate.mjs
services/sync-committee/payment-receipts.mjs
services/sync-committee/mcp-metadata.mjs
services/sync-committee/test/x402-gate.test.mjs
```

Modify:

```text
services/sync-committee/server.mjs
services/sync-committee/README.md
docs/sync-committee-service.md
package.json
```

Potentially add dependencies:

```json
{
  "@x402/core": "...",
  "@x402/evm": "...",
  "@x402/express": "..."
}
```

But prefer minimal dependency scope. The current service uses `node:http`, not Express. There are two viable paths:

### 4.2 Path A: Use x402 Express Middleware

Pros:

- Fastest correct implementation.
- Matches x402 seller quickstart.
- Less protocol surface to hand-roll.
- Easier future use of extensions such as discovery, payment identifiers, offers/receipts.

Cons:

- Requires converting or wrapping current `node:http` service into Express.
- Adds dependencies.
- May be more invasive than needed.

Recommended if speed to live endpoint is the top priority.

### 4.3 Path B: Manual Facilitator Client Around Existing Server

Pros:

- Minimal change to existing server.
- Keeps zero/low dependency style.
- Clearer control of payment state and response timing.

Cons:

- Higher risk of subtle protocol mismatch.
- Must track x402 header/response changes manually.
- Extensions become manual work.

Recommended only if avoiding Express is more important than integration speed.

### 4.4 Recommended Decision

Use Path A for the first paid endpoint unless the x402 middleware cannot protect `POST` routes with the required body handling. The official x402 docs provide Express examples and route-based protection.

If Express conversion feels too invasive, implement Path B as a small isolated module, but use official x402 package types where possible.

## 5. Detailed Request Lifecycle

### 5.1 Unpaid Request

Client sends:

```http
POST /v1/sync-committee/verify
Content-Type: application/json

{ ... request body ... }
```

Server behavior:

- Do not run verifier.
- Do not dispatch to HyperBEAM/subprocess.
- Construct payment requirements.
- Return `402 Payment Required`.

Response:

```http
HTTP/1.1 402 Payment Required
Content-Type: application/json
PAYMENT-REQUIRED: <base64-json-payment-requirements>
```

Body:

```json
{
  "error": "payment_required",
  "service": "A-202",
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:84532",
      "price": "$0.001",
      "payTo": "0x..."
    }
  ]
}
```

Exact body shape should match x402 SDK expectations. Do not invent custom semantics unless wrapped inside a documented extension field.

### 5.2 Paid Retry

Client retries:

```http
POST /v1/sync-committee/verify
Content-Type: application/json
PAYMENT-SIGNATURE: <base64-payment-payload>

{ ... same request body ... }
```

Server behavior:

1. Read request.
2. Validate schema.
3. Compute request hash.
4. Verify payment payload via facilitator.
5. Reject if invalid.
6. Dispatch verifier.
7. Settle payment via facilitator.
8. Persist receipt/evidence.
9. Return result.

Response:

```http
HTTP/1.1 200 OK
Content-Type: application/json
PAYMENT-RESPONSE: <base64-json-settlement-response>
X-PAXIOM-REQUEST-HASH: <sha256>
X-PAXIOM-EVIDENCE-ID: <ao/arweave/local id>
```

Body:

```json
{
  "verified": true,
  "service": "A-202",
  "slot": "14245526",
  "fork_version": "0x06000000",
  "domain": "0x...",
  "signing_root": "0x...",
  "participating": 510,
  "committee_size": 512,
  "primitive_return_code": 1,
  "platform_signature": "0x...",
  "ao_message_id": "...",
  "payment": {
    "network": "eip155:84532",
    "scheme": "exact",
    "price": "$0.001",
    "settled": true
  }
}
```

Question to decide:

Should `payment` appear in the body, or only in `PAYMENT-RESPONSE`?

Recommendation:

- Include a small, non-sensitive payment summary in body.
- Full settlement response remains in `PAYMENT-RESPONSE`.

## 6. Fail-Closed Rules

Production must fail closed.

### 6.1 Required Production Env

In production:

```text
NODE_ENV=production
REQUIRE_X402=1
MOCK_DEVICE=0
BLS_DEVICE_VIA_SUBPROCESS=1 or HyperBEAM mode
PAXIOM_RECEIVING_WALLET=0x...
X402_NETWORK=eip155:8453
X402_FACILITATOR_URL=https://...
X402_PRICE_SYNC_COMMITTEE_USD=0.01
PAXIOM_PLATFORM_SIGNING_KEY=...
```

Startup should refuse to boot if:

- `NODE_ENV=production` and `REQUIRE_X402` is not `1`
- `NODE_ENV=production` and `MOCK_DEVICE=1`
- `PAXIOM_RECEIVING_WALLET` missing
- `X402_FACILITATOR_URL` missing
- price missing
- dispatcher target missing
- platform signing key missing if response signing is production requirement

### 6.2 Payment Failure

If no `PAYMENT-SIGNATURE`:

```text
return 402
do not dispatch
```

If facilitator `/verify` fails:

```text
return 402
do not dispatch
```

If facilitator `/verify` succeeds but `/settle` fails:

Preferred strict policy:

```text
return 402 or 502
do not include verifier result
log failed settlement
```

Alternative policy:

```text
return result only after settlement
```

Recommendation:

Settle before returning premium result. If work is expensive, verify first, run work second, settle third, return result only after settlement. This can waste compute when settlement fails, but prevents unpaid access.

### 6.3 Dispatch Failure

If verifier fails for technical reasons after payment verification but before settlement:

Options:

1. Do not settle payment; return `502`.
2. Settle and return failed verification response.

Recommendation:

Do not settle for infrastructure failure. Settle only when the service produced a valid response, even if that response is `verified: false`.

Important distinction:

- `verified: false` is a valid paid answer.
- `dispatch failed` is not a valid paid answer.

## 7. Idempotency And Replay

### 7.1 Why It Matters

Clients will retry requests. Networks fail. Facilitators can time out. The service must avoid:

- charging twice for same logical request
- returning two different answers for same paid request
- settling same payment twice where protocol permits duplicates

### 7.2 Recommended Idempotency Strategy

Implement two hashes:

```text
request_hash = sha256(canonical_json(request_body))
payment_payload_hash = sha256(PAYMENT-SIGNATURE)
```

Store:

```json
{
  "request_hash": "...",
  "payment_payload_hash": "...",
  "payment_identifier": "... optional x402 extension ...",
  "status": "settled",
  "response_body": { ... },
  "payment_response": { ... },
  "created_at": "...",
  "expires_at": "..."
}
```

Minimum storage for MVP:

```text
.paxiom-runtime/x402-idempotency.jsonl
```

Production storage:

```text
Redis or SQLite
```

Recommendation for first public endpoint:

Use SQLite. It is enough for one server and easier to inspect.

### 7.3 Payment-Identifier Extension

x402 has a payment-identifier extension for idempotency. Use it when available.

Plan:

- M0: implement local request/payment hash dedup.
- M1: add official payment-identifier extension support.
- M2: cache response by payment id for at least one hour.

## 8. Evidence And Audit

### 8.1 MVP Evidence

For every paid call, write a local JSONL record:

```text
.paxiom-runtime/evidence/sync-committee-paid.jsonl
```

Fields:

```json
{
  "event_type": "SyncCommitteeVerifyPaid",
  "request_uuid": "...",
  "request_hash": "...",
  "slot": "14245526",
  "verified": true,
  "participating": 510,
  "committee_size": 512,
  "primitive_return_code": 1,
  "payment": {
    "scheme": "exact",
    "network": "eip155:84532",
    "price": "$0.001",
    "pay_to": "0x...",
    "facilitator_url": "https://x402.org/facilitator",
    "verify_ok": true,
    "settle_ok": true,
    "settlement_tx": "..."
  },
  "response_hash": "...",
  "ao_message_id": "...",
  "created_at": "..."
}
```

### 8.2 Paxiom-Grade Evidence

After MVP:

- write receipt/evidence to AO compliance process
- write proof packet to Arweave/Load where feasible
- expose `evidence_url` or `evidence_id` in response
- include `X-PAXIOM-EVIDENCE-ID`

### 8.3 What Counts As Evidence

For A-202:

- request body hash
- slot
- block root
- parent root
- sync aggregate hash
- verifier version
- fork version
- signing root
- participating count
- primitive return code
- platform signature
- payment settlement reference
- AO message id
- code version/git SHA

Do not store private client data unless needed. This endpoint should not require client PII.

## 9. MCP Packaging

### 9.1 Why MCP Matters

x402 lets agents pay. MCP lets agents discover and invoke tools. A paid endpoint without MCP metadata is technically usable but less agent-native.

### 9.2 First MCP Tool

Tool name:

```text
paxiom_verify_sync_committee
```

Description:

```text
Verify that an Ethereum sync committee signed a supplied header root for a slot. Returns verification result, signing root, participation count, platform signature, and evidence id.
```

Input schema:

```json
{
  "type": "object",
  "required": ["slot", "block_root", "parent_root", "sync_aggregate"],
  "properties": {
    "slot": {
      "type": "string",
      "description": "Ethereum consensus slot as a decimal string"
    },
    "block_root": {
      "type": "string",
      "pattern": "^0x[0-9a-fA-F]{64}$"
    },
    "parent_root": {
      "type": "string",
      "pattern": "^0x[0-9a-fA-F]{64}$"
    },
    "sync_aggregate": {
      "type": "object",
      "required": ["sync_committee_bits", "sync_committee_signature"],
      "properties": {
        "sync_committee_bits": {
          "type": "string",
          "description": "Hex bitfield"
        },
        "sync_committee_signature": {
          "type": "string",
          "description": "Hex BLS aggregate signature"
        }
      }
    }
  }
}
```

Output schema:

```json
{
  "type": "object",
  "required": ["verified", "service", "slot", "signing_root", "participating", "committee_size"],
  "properties": {
    "verified": { "type": "boolean" },
    "service": { "type": "string" },
    "slot": { "type": "string" },
    "fork_version": { "type": "string" },
    "domain": { "type": "string" },
    "signing_root": { "type": "string" },
    "participating": { "type": "integer" },
    "committee_size": { "type": "integer" },
    "primitive_return_code": { "type": "integer" },
    "platform_signature": { "type": "string" },
    "ao_message_id": { "type": "string" },
    "evidence_id": { "type": "string" },
    "payment": { "type": "object" }
  }
}
```

### 9.3 MCP Server Shape

Minimal MCP server:

```text
GET /.well-known/paxiom-mcp.json
```

or a proper MCP transport if targeting runtime integration.

For the first public version, at minimum publish:

```text
/mcp/tools.json
/mcp/paxiom-sync-committee.json
```

These can be static metadata before full MCP server implementation.

## 10. Public Documentation

Add a public docs page:

```text
paxiom-static/x402-sync-committee.html
```

Or add section to:

```text
paxiom-static/services.html
```

Minimum content:

- endpoint URL
- price
- network
- token
- request schema
- response schema
- x402 flow
- sample unpaid `curl`
- sample paid client command
- limitations
- evidence/replay story

The page must say clearly:

```text
This is the first paid Paxiom endpoint. It verifies Ethereum sync committee signatures. It is not the S.03 historical-state endpoint yet.
```

## 11. Deployment Specification

### 11.1 Host

Minimum viable:

- small VPS
- Ubuntu
- Node 20+ or Node 22+
- Nginx/Caddy HTTPS reverse proxy
- systemd service

Preferred:

- Caddy for automatic TLS
- service user `paxiom`
- environment file not committed to git

### 11.2 Process

Systemd unit:

```ini
[Unit]
Description=Paxiom Sync Committee x402 Endpoint
After=network-online.target
Wants=network-online.target

[Service]
User=paxiom
WorkingDirectory=/srv/paxiom
EnvironmentFile=/etc/paxiom/sync-committee.env
ExecStart=/usr/bin/node services/sync-committee/server.mjs
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Environment file:

```text
NODE_ENV=production
SYNC_COMMITTEE_HOST=127.0.0.1
SYNC_COMMITTEE_PORT=8080
REQUIRE_X402=1
MOCK_DEVICE=0
BLS_DEVICE_VIA_SUBPROCESS=1
BLS_DEVICE_HARNESS=/srv/bls-verifier/target/release/bls-device-harness
X402_FACILITATOR_URL=https://...
X402_NETWORK=eip155:8453
X402_PRICE_SYNC_COMMITTEE_USD=0.01
PAXIOM_RECEIVING_WALLET=0x...
PAXIOM_EVIDENCE_DIR=/var/lib/paxiom/evidence
PAXIOM_IDEMPOTENCY_DB=/var/lib/paxiom/idempotency.sqlite
```

### 11.3 Reverse Proxy

Public URL:

```text
https://api.paxiom.org/v1/sync-committee/verify
```

Caddy:

```caddy
api.paxiom.org {
  encode gzip
  reverse_proxy 127.0.0.1:8080
}
```

Nginx equivalent is fine.

### 11.4 Security Controls

Required:

- HTTPS only.
- Body size limit, recommended 128 KiB.
- Method restriction.
- JSON content type enforcement.
- Timeout around verifier dispatch.
- Timeout around facilitator calls.
- No mock mode in production.
- Structured logs.
- No private key in command line args.
- Receiving wallet separate from treasury wallet.

Recommended:

- rate limiting by IP
- per-wallet request volume dashboard
- alert on payment verify failures
- alert on settlement failures
- alert on `verified=false` spike
- health endpoint excluded from payment

## 12. Test Plan

### 12.1 Unit Tests

Add tests for:

- missing payment returns `402`
- missing payment does not call dispatch
- malformed payment returns `402`
- facilitator verify failure returns `402`
- facilitator settle failure does not return premium result
- successful payment calls dispatch once
- successful payment returns `PAYMENT-RESPONSE`
- production refuses `MOCK_DEVICE=1`
- production refuses missing receiving wallet
- production refuses missing facilitator URL

### 12.2 Integration Tests

Local mock facilitator:

- implement fake `/verify`
- implement fake `/settle`
- deterministic success/failure cases

Test matrix:

| Case | Payment | Verify | Dispatch | Settle | Expected |
| --- | --- | --- | --- | --- | --- |
| unpaid | none | n/a | no | no | 402 |
| fake payment | invalid | fail | no | no | 402 |
| valid payment, invalid request | valid | no | no | no | 400 |
| valid payment, verifier fails infra | valid | ok | fail | no | 502 |
| valid payment, verified false | valid | ok | ok | ok | 200, `verified:false` |
| valid payment, verified true | valid | ok | ok | ok | 200, `verified:true` |
| settle fail | valid | ok | ok | fail | no premium body |

### 12.3 Testnet E2E

Use Base Sepolia:

```text
network: eip155:84532
facilitator: https://x402.org/facilitator
price: $0.001
```

Acceptance:

- unpaid curl returns `402`
- x402 buyer client pays and receives `200`
- receiving wallet balance changes or settlement reference confirms payment
- response includes `PAYMENT-RESPONSE`
- local evidence record exists
- logs include request hash and settlement id

### 12.4 Mainnet Smoke

Use Base mainnet:

```text
network: eip155:8453
price: $0.01
```

Acceptance:

- same as testnet
- production facilitator confirmed
- public endpoint under HTTPS
- no mock dispatch

## 13. First Implementation Tasks

### Task 1: Decide Integration Path

Owner: engineering

Decision:

```text
Express middleware vs manual facilitator client
```

Recommendation:

```text
Use official x402 middleware if it can protect POST /v1/sync-committee/verify cleanly.
```

Acceptance:

- design note in `docs/sync-committee-service.md`
- dependency decision recorded

### Task 2: Add Payment Config

Create:

```text
services/sync-committee/x402-config.mjs
```

Exports:

```js
export function loadX402Config() { ... }
export function assertProductionSafe(config) { ... }
```

Config fields:

```text
requireX402
facilitatorUrl
network
price
payTo
scheme
route
description
mimeType
```

Acceptance:

- production startup fails if required config missing
- test mode supports Base Sepolia defaults

### Task 3: Replace Stub Header Check

Modify:

```text
services/sync-committee/server.mjs
```

Add:

```text
PAYMENT-SIGNATURE
PAYMENT-REQUIRED
PAYMENT-RESPONSE
```

Acceptance:

- no payment -> proper `402`
- fake header -> no dispatch
- valid mocked facilitator -> dispatch

### Task 4: Add Facilitator Verify/Settle

Create:

```text
services/sync-committee/x402-gate.mjs
```

Interface:

```js
export async function requirePayment({ req, res, body, requestHash, routeConfig }) {
  // returns { paid: true, paymentPayload, paymentDetails, verification }
  // or writes 402 and returns { paid: false }
}

export async function settlePayment({ paymentPayload, paymentDetails, responseHash }) {
  // returns settlement response
}
```

Acceptance:

- verify called before dispatch
- settle called after dispatch
- premium response only returned after settle success

### Task 5: Add Evidence Writer

Create:

```text
services/sync-committee/payment-receipts.mjs
```

Writes:

```text
.paxiom-runtime/evidence/sync-committee-paid.jsonl
```

Acceptance:

- every successful paid response writes one evidence record
- evidence record contains request hash, response hash, slot, payment network, settlement status, git SHA if available

### Task 6: Add Tests

Create:

```text
services/sync-committee/test/x402-gate.test.mjs
```

Modify existing:

```text
services/sync-committee/test/server.test.mjs
```

Acceptance:

```bash
npm run test:sync-committee
```

passes with:

- payment disabled
- payment required + mock facilitator
- production safety checks

### Task 7: Add MCP Metadata

Create:

```text
services/sync-committee/mcp-metadata.mjs
```

Routes:

```text
GET /mcp/tools.json
GET /mcp/paxiom-sync-committee.json
```

Acceptance:

- returns valid JSON
- includes input schema
- includes output schema
- includes price
- includes x402 payment metadata

### Task 8: Add Public Docs

Update:

```text
paxiom-static/services.html
```

Or create:

```text
paxiom-static/sync-committee-api.html
```

Acceptance:

- outside reader can understand what the endpoint sells
- sample curl shown
- limitations clear
- S.03 not implied

### Task 9: Deploy Testnet Endpoint

Acceptance:

- endpoint publicly reachable
- HTTPS valid
- unpaid call returns `402`
- paid call returns `200`
- evidence record written
- health check works
- logs visible

### Task 10: Mainnet Pilot

Acceptance:

- real Base USDC settlement
- receiving wallet gets funds
- first public paid call recorded
- docs updated with "live pilot" status

## 14. Open Decisions For Review

### Decision A: First Endpoint Price

Options:

- `$0.001`: easiest for testing
- `$0.01`: real but low-friction
- `$0.05`: more serious signal, more friction

Recommendation:

```text
$0.001 testnet/dev, $0.01 first mainnet pilot.
```

### Decision B: Mainnet Facilitator

Options:

- hosted production facilitator
- self-host x402 facilitator

Recommendation:

```text
Use hosted production facilitator first. Self-host later if revenue or reliability justifies it.
```

### Decision C: Dispatch Mode For First Paid Pilot

Options:

- `MOCK_DEVICE=1`
- `BLS_DEVICE_VIA_SUBPROCESS=1`
- HyperBEAM device registration

Recommendation:

```text
Never charge for MOCK_DEVICE. Use subprocess first because it already produced real mainnet `verified:true` evidence. Move to HyperBEAM-hosted device after registration is proven.
```

### Decision D: Settle Before Or After Work

Options:

- verify payment -> settle -> run work
- verify payment -> run work -> settle -> return

Recommendation:

```text
verify payment -> run work -> settle -> return
```

Reason:

- Do not charge for infrastructure failure.
- Do charge for valid `verified:false` answers.
- Do not return premium result unless settlement succeeds.

### Decision E: Where To Put First Public Docs

Options:

- add to `services.html`
- create dedicated `sync-committee-api.html`
- create developer docs repo page

Recommendation:

```text
Dedicated `sync-committee-api.html`, linked from `services.html`.
```

## 15. Revenue Readiness Checklist

### Protocol

- [ ] Real `402 Payment Required` response.
- [ ] Proper `PAYMENT-REQUIRED` header.
- [ ] Proper `PAYMENT-SIGNATURE` parsing.
- [ ] Facilitator `/verify`.
- [ ] Facilitator `/settle`.
- [ ] Proper `PAYMENT-RESPONSE` header.
- [ ] Base Sepolia testnet success.
- [ ] Base mainnet success.

### Product

- [ ] Public endpoint URL.
- [ ] Clear price.
- [ ] Clear service description.
- [ ] Request/response schema.
- [ ] Example client request.
- [ ] Example unpaid `402`.
- [ ] Example paid success.
- [ ] Limitations documented.

### Trust

- [ ] No mock mode in paid production.
- [ ] Real verifier path.
- [ ] Request hash.
- [ ] Response hash.
- [ ] Evidence record.
- [ ] Platform signature.
- [ ] Settlement reference.
- [ ] Git SHA/version in evidence.

### Operations

- [ ] HTTPS.
- [ ] systemd/process manager.
- [ ] logs.
- [ ] health check.
- [ ] rate limit.
- [ ] body size limit.
- [ ] alert on failures.
- [ ] receiving wallet monitored.

### Agent Discoverability

- [ ] MCP tool metadata.
- [ ] x402/Bazaar discovery metadata if available.
- [ ] endpoint listed somewhere public.
- [ ] concise docs page.

## 16. Definition Of Done

### DOD 1: Testnet x402 Endpoint

Done when:

- `POST /v1/sync-committee/verify` returns `402` without payment.
- x402 test client can pay via Base Sepolia.
- service returns `200` after settlement.
- verifier response shape unchanged.
- local evidence JSONL entry written.
- tests pass.

### DOD 2: Public Pilot Endpoint

Done when:

- public HTTPS endpoint exists.
- production refuses mock mode.
- paid Base mainnet call settles to Paxiom wallet.
- endpoint docs are published.
- MCP metadata is published.
- logs/evidence are inspectable.
- at least one external wallet successfully pays and receives response.

### DOD 3: Revenue-Worthy Paxiom Endpoint

Done when:

- paid calls settle reliably.
- response contains platform signature.
- evidence packet is durable beyond local disk.
- endpoint appears in x402/MCP discovery surface.
- public docs explain why the result is verifiable.
- one outside user or agent pays because they want the answer, not because they are testing the protocol.

## 17. Bottom Line

Paxiom is close to protocol revenue but not yet close to meaningful product revenue.

The gap is not cryptography. The gap is payment enforcement, product packaging, and evidence posture.

The fastest credible path is:

```text
A-202 sync committee endpoint
-> real x402 facilitator verify/settle
-> Base Sepolia rehearsal
-> Base mainnet pilot
-> MCP metadata
-> durable evidence packet
```

Do this before S.03. S.03 is the more valuable endpoint, but A-202 is the shortest path to a real paid Paxiom transaction.
