# arb-runner

Autonomous execution service for the cross-chain arb engine. Manages an operator
wallet, spawns `sdk/live-executor.js` as a managed child, and exposes engine
controls + per-chain balances + performance metrics over HTTP.

MetaMask is for the user (deploy capital, emergency sweep). The operator key
signs trades autonomously inside the spawned executor.

## Operator key

### Default location

`~/.paxiom/arb-runner/operator.key` — **outside** the project tree.

The earlier in-repo location (`~/paxiom/.arb-runner/operator.key`) is honored
as a read-only fallback for backward compatibility, with a startup warning.
Move it out:

```bash
mkdir -p ~/.paxiom/arb-runner
mv ~/paxiom/.arb-runner/operator.key ~/.paxiom/arb-runner/operator.key
chmod 600 ~/.paxiom/arb-runner/operator.key
```

### Override

- `OPERATOR_KEY_FILE=/secure/path/key` — explicit file path
- `OPERATOR_KEY_DIR=/secure/path` — directory holding `operator.key`
- `OPERATOR_PRIVATE_KEY=0x…` — bypass file entirely (bring your own key, e.g.
  decrypted at boot from a vault)

### Backup

The key is unrecoverable if lost. Any USDC/WETH/ETH at the operator address
becomes stranded.

```bash
# Read once; never log to terminal history
cat ~/.paxiom/arb-runner/operator.key
# → 0x… 32-byte hex

# Then: paste into a password manager (1Password / Bitwarden secure note)
# Tag it: paxiom / arb-runner / operator key / address: 0x… (matches UI)
```

### Recovery on a new machine

1. Install paxiom repo, install deps
2. Restore the key:
   ```bash
   mkdir -p ~/.paxiom/arb-runner
   chmod 700 ~/.paxiom/arb-runner
   cat > ~/.paxiom/arb-runner/operator.key <<EOF
   0xYOUR_BACKED_UP_KEY
   EOF
   chmod 600 ~/.paxiom/arb-runner/operator.key
   ```
3. Start the stack — the runner reads the key and reports the same address as before.

### Rotation

If the key is compromised, **immediately**:

1. UI → Emergency Close (halts the engine, writes the kill file)
2. UI → Inventory → withdraw all balances (USDC, WETH, ETH on each chain) back to MetaMask
3. Move the old key file aside: `mv ~/.paxiom/arb-runner/operator.key{,.compromised-$(date +%s)}`
4. Restart arb-runner — generates a fresh key, prints the new address
5. Future deploys send capital to the new address

## HTTP surface

All routes live under `http://127.0.0.1:8086/`. The UI proxies them at
`/api/arb/*` with auth gating on privileged routes (see below).

### Read-only (no auth required)

- `GET /healthz`
- `GET /v1/runner/status`
- `GET /v1/runner/wallet` — operator address + balances on all 3 chains
- `GET /v1/runner/external-wallet?address=0x…` — read any address's balances
- `GET /v1/runner/performance` — aggregate from execution.log + unwind.log
- `GET /v1/runner/preflight?tradeSizeUsd=N` — go/no-go check before start
- `GET /v1/runner/test-roundtrip-status` — live status of in-progress path test

### Privileged (auth-gated at UI layer)

These are gated by SIWE session tokens at the UI proxy (`/api/arb/*`). Direct
access to the runner port (8086) is not auth-gated — keep the runner bound to
127.0.0.1 only.

- `POST /v1/runner/start` — spawn live-executor child
- `POST /v1/runner/stop` — SIGTERM the child
- `POST /v1/runner/emergency-close` — sticky halt + kill file
- `POST /v1/runner/clear-emergency` — reset the sticky halt
- `POST /v1/runner/withdraw` — operator signs ERC20 / native ETH transfer
- `POST /v1/runner/test-roundtrip` — Base path test (single chain)
- `POST /v1/runner/test-crosschain-loop` — synthetic cross-chain loop rehearsal;
  writes an execution record for the unwind monitor/UI without approvals, swaps,
  Uniswap, or any broadcast transaction

## Auth

The UI server (`ui/server.js`) gates all privileged proxy routes behind a SIWE
session token. The token is issued by `/api/session/verify` after a successful
MetaMask sign-in. The UI sends it as `Authorization: Bearer <token>` on each
privileged call.

To run without auth (local dev only): `PAXIOM_DISABLE_AUTH=1`.

## Cross-chain only

The live executor refuses same-chain opportunities. Same-chain atomic flash arb
is a saturated MEV market with structural advantages we don't have. The Paxiom
edge is cross-chain inventory arb, where the multi-chain pre-positioning
requirement keeps the competitor pool small.

If a same-chain opportunity is sent (scanner, AO signal, manual POST), the
executor logs `rejected_same_chain` to `execution.log` and skips it.

## Loop rehearsal vs venue test

The full Paxiom arb loop is scanner/opportunity intake, execution record,
half-fill classification, trade list, performance accounting, and emergency
controls. That loop does not require Uniswap. Use
`POST /v1/runner/test-crosschain-loop` to rehearse it with a synthetic BOTH_OK
cross-chain record.

The Base round-trip endpoint is a separate venue/path test. It specifically
proves WETH wrapping, ERC20 approvals, Uniswap V3 quote/swap calldata, slippage
minimums, and receipt handling on Base.
