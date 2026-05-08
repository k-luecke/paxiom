#!/usr/bin/env node
// One-shot demo for fixture-proof-verifier-v0:
//   1. POST a known fixture_id with claimed_result="pass"
//   2. print the signed receipt
//   3. recompute hash + verify signature in-process
//   4. hit /replay/:id to confirm the chassis agrees
//
// Run: npm run verify:fixture-demo

import { createPublicKey } from 'node:crypto';
import { verifyReceiptSignature } from '../lib/receipt.mjs';
import { createApp } from '../server.mjs';

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
      verifier: 'fixture-proof-verifier-v0',
      fixture_id: 'fp-v0-canonical-pass',
      claimed_result: 'pass',
    }),
  });
  const verifyBody = await verifyResp.json();
  console.log('=== POST /verify (fixture-proof-verifier-v0) ===');
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
  if (!check.ok || receipt.decision !== 'pass') process.exitCode = 1;
} finally {
  server.close();
}
