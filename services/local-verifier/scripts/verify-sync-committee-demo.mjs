#!/usr/bin/env node
// One-shot demo for sync-committee-fixture-verifier-v0:
//   1. read services/local-verifier/fixtures/sc-v0-period-1041-good.json
//   2. POST /verify with claimed_header_root + claimed_participation
//   3. print the signed receipt and replay it
//
// v0 verifies fixture structure + SSZ-style domain/signing_root + participation.
// It does NOT verify the BLS aggregate signature; details.bls_aggregate_verified
// is false on every receipt.
//
// Run: npm run verify:sync-committee-demo

import { createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyReceiptSignature } from '../lib/receipt.mjs';
import { createApp } from '../server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, '..', 'fixtures', 'sc-v0-period-1041-good.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

const app = createApp();
const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

try {
  const verifyResp = await fetch(`${base}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      verifier: 'sync-committee-fixture-verifier-v0',
      fixture_id: fixture.fixture_id,
      claimed_header_root: fixture.block_root,
      claimed_participation: fixture.expected.participation,
    }),
  });
  const verifyBody = await verifyResp.json();
  console.log('=== POST /verify (sync-committee-fixture-verifier-v0) ===');
  console.log('status:', verifyResp.status);
  console.log(JSON.stringify(verifyBody, null, 2));

  const receipt = verifyBody.receipt;
  const servicePub = createPublicKey(receipt.service_signature.public_key_pem);
  const check = verifyReceiptSignature(receipt, servicePub);
  console.log('\n=== local replay (in-process) ===');
  console.log(JSON.stringify({
    recomputed_hash: check.recomputedHash,
    signature_valid: check.ok,
  }, null, 2));

  const replayResp = await fetch(`${base}/replay/${receipt.receipt_id}`);
  console.log('\n=== GET /replay/:id ===');
  console.log('status:', replayResp.status);
  console.log(await replayResp.text());

  console.log('\n=== replay command ===');
  console.log(receipt.replay_command);
  console.log('\nNOTE: bls_aggregate_verified =', verifyBody.details.bls_aggregate_verified,
              '(v0 does not verify BLS aggregate; that is sync-committee-bls-verifier-v1).');
  if (!check.ok || receipt.decision !== 'pass') process.exitCode = 1;
} finally {
  server.close();
}
