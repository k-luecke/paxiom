#!/usr/bin/env node
// One-shot demo: spin up the service in-process, post a known sha256 claim,
// print the receipt, then recompute the hash and verify the signature.
//
// Run: npm run verify:demo

import { createApp } from '../server.mjs';
import { createHash, createPublicKey } from 'node:crypto';
import { verifyReceiptSignature } from '../lib/receipt.mjs';

const message = 'hello';
const claimedSha256 = createHash('sha256').update(message).digest('hex');

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
    body: JSON.stringify({ message, claimed_sha256: claimedSha256 }),
  });
  const verifyBody = await verifyResp.json();
  console.log('=== POST /verify ===');
  console.log('status:', verifyResp.status);
  console.log(JSON.stringify(verifyBody, null, 2));

  const receipt = verifyBody.receipt;
  const publicKey = createPublicKey(receipt.service_signature.public_key_pem);
  const check = verifyReceiptSignature(receipt, publicKey);
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
  if (!check.ok) process.exitCode = 1;
} finally {
  server.close();
}
