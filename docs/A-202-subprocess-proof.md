# A-202 — Subprocess-mode acceptance proof (Slice 1A)

Wires paxiom's existing `BLS_DEVICE_VIA_SUBPROCESS=1` dispatch path
(`services/sync-committee/dispatch.mjs`) to the new
`bls-device-harness` binary in
`k-luecke/bls-verifier@claude/a202-subprocess-harness-DYqhU` and
asserts the response envelope is real and Slice-1A-honest.

## What is in this slice

| Repo            | Branch                                       | Files                                                                 |
|-----------------|----------------------------------------------|-----------------------------------------------------------------------|
| bls-verifier    | `claude/a202-subprocess-harness-DYqhU`       | `bls-device/Cargo.toml` + `bls-device/src/bin/harness.rs` + `docs/O-702` |
| paxiom          | `claude/a202-subprocess-harness-DYqhU`       | `scripts/verify-a202-subprocess.sh` + fixture + `CAPTURE.md` + this doc + `evidence/A-202/.gitignore` |

paxiom service code (`dispatch.mjs`, `server.mjs`, `envelope.mjs`,
`x402.mjs`) is **untouched**. Subprocess dispatch was already shipped
on `main`; the missing piece was the binary it spawns.

## Slice 1A invariants (enforced by the proof script)

- `envelope.service == "A-202"`.
- `envelope.platformSignature.algorithm == "ed25519"` and `keyId` non-empty.
- No `algorithm:"dev"` substring anywhere in the response (forbidden).
- `artifact.payload.mock` is `false` or absent.
- `artifact.payload.settlement_verified == false` (no payment claim).
- `artifact.payload.key_scope` ∈ {`ephemeral-subprocess`,
  `operator-supplied`}.
- `artifact.payload.notary_status` ∈ {`not-persistent`,
  `operator-supplied`} — NEVER `durable`, `production`, or `tee-backed`.
- `artifact.payload.x402_mode` ∈ {`disabled`, `stub`}.

## Procedure

1. Build the harness — see
   `bls-verifier/docs/O-702-bls-device-harness-runbook.md`.

2. Generate a paxiom outer-envelope ed25519 key (one-time, store outside
   the repo):

   ```
   openssl genpkey -algorithm ed25519 -out ~/.paxiom/keys/testnet-resp.pem
   ```

3. (Optional) Capture a real `VerifyRequest` per
   `fixtures/sync-committee/CAPTURE.md`. The shipped fixture is
   shape-only — the script will pass without `verified:true` since
   slice acceptance is wire-path correctness + Slice-1A invariants,
   not BLS verdict.

4. Run the proof:

   ```
   BLS_DEVICE_HARNESS=/abs/path/to/target/release/bls-device-harness \
   PAXIOM_RESPONSE_SIGNING_PRIVATE_KEY_PEM="$(cat ~/.paxiom/keys/testnet-resp.pem)" \
   bash scripts/verify-a202-subprocess.sh
   ```

   - PASS prints `PASS — evidence: evidence/A-202/<unix_ts>-<sha8>/`.
   - FAIL exits non-zero with the failed assertion and the evidence path.

## Evidence captured per run

`evidence/A-202/<unix_ts>-<request_sha8>/`:

- `request.json`        — the fixture posted to paxiom
- `response.json`       — paxiom's full HTTP response body
- `server.stdout`       — paxiom server stdout for the run
- `server.stderr`       — paxiom server stderr (includes harness stderr)
- `meta.json`           — git commit, harness path, fixture sha,
                          response sha, http status, x402 mode,
                          expected verified hint, started/finished_at

## Out of scope (named follow-ups)

- Real Coinbase x402 facilitator wiring — punch-list **Slice 3**.
- Persistent inner-ring signing key — punch-list **Slice 2** /
  bls-verifier O-720.
- Durable AO/Arweave write — punch-list **Slice 5**.
- Slot-mismatch rejection (request slot vs. harness-consumed slot
  echoed as separate envelope fields) — Slice 1A red-team follow-up.

## Rollback

Both branches are additive and unmerged. To roll back:

- `bls-verifier`: delete remote branch `claude/a202-subprocess-harness-DYqhU`
  (master is unaffected; the harness binary doesn't exist on master).
- `paxiom`: delete remote branch `claude/a202-subprocess-harness-DYqhU`
  (main is unaffected; the script + fixture + docs only live on the
  branch).
