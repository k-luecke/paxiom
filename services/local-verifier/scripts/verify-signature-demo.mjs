#!/usr/bin/env node
// One-shot demo for signature-verifier-v0:
//   1. generate an ed25519 keypair
//   2. sign canonical JSON of a payload
//   3. POST to /verify with verifier="signature-verifier-v0"
//   4. print the signed receipt and replay it
//
// Run: npm run verify:signature-demo

import { generateKeyPairSync, sign as cryptoSign, createPublicKey } from 'node:crypto';
import { canonicalJson } from '../lib/canonical.mjs';
import { verifyReceiptSignature } from '../lib/receipt.mjs';
import { createApp } from '../server.mjs';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();

const payload = { message: 'hello', user: 'alice' };
const payloadBytes = Buffer.from(canonicalJson(payload), 'utf8');
const signature = cryptoSign(null, payloadBytes, privateKey).toString('base64');

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
      verifier: 'signature-verifier-v0',
      payload,
      public_key_pem: publicKeyPem,
      signature,
      algorithm: 'ed25519',
    }),
  });
  const verifyBody = await verifyResp.json();
  console.log('=== POST /verify (signature-verifier-v0) ===');
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
