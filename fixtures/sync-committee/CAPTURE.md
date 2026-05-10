# Capturing a real sync committee VerifyRequest fixture

`known-good-request.json` ships SHAPE-ONLY. All hex fields have the
right length but are zero-filled, so the harness will return
`verified:false` (typically `primitive_return_code:-2` or `-5`, or fail
upstream at beacon fork lookup if the slot is invalid). Slice 1A's
wire-path acceptance script (`scripts/verify-a202-subprocess.sh`) does
NOT assert `verified:true` — it only asserts the envelope shape,
signature algorithm, and the Slice-1A truth invariants
(`settlement_verified:false`, `notary_status` not durable/production/
tee-backed, `x402_mode` is disabled or stub).

If you need `verified:true` evidence, capture a real fixture:

1. Choose a slot in a closed sync committee period:

   ```
   period             = slot / 8192
   end_of_period_slot = (period + 1) * 8192 - 1
   ```

   Pick a slot whose `end_of_period_slot` is < current head. The
   committee for that period is then immutable.

2. Use `bls-verifier`'s `record-fixture` binary to dump beacon state:

   ```
   cd <path-to>/bls-verifier
   cargo run --release -p bls-device --bin record-fixture -- \
     --beacon https://lodestar-mainnet.chainsafe.io \
     --slot <slot> \
     --out /tmp/fixture-<slot>
   ```

3. Hand-build the request from the recorded beacon block:

   - `slot`              = `<slot>` as a string
   - `block_root`        = `data.root` from
     `/eth/v1/beacon/headers/<slot>`
   - `parent_root`       = `data.message.parent_root` from
     `/eth/v2/beacon/blocks/<slot>`
   - `sync_aggregate.sync_committee_bits`
                          = `data.message.body.sync_aggregate.sync_committee_bits`
   - `sync_aggregate.sync_committee_signature`
                          = `data.message.body.sync_aggregate.sync_committee_signature`

4. Overwrite `fixtures/sync-committee/known-good-request.json` and
   re-run the proof with `EXPECTED_VERIFIED=true`.
