#!/usr/bin/env node
// One-shot demo for ethereum-mpt-fixture-verifier-v0:
//   1. read load-network/fixtures/{block,account,storage}_19000000_*.json
//   2. POST an account proof verification, then a storage proof verification
//   3. print the signed receipts, replay each one
//
// Run: npm run verify:ethereum-mpt-demo

import { createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyReceiptSignature } from '../lib/receipt.mjs';
import { createApp } from '../server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoFixtures = join(here, '..', '..', '..', 'load-network', 'fixtures');
const block = JSON.parse(readFileSync(join(repoFixtures, 'block_19000000.json'), 'utf8'));
const account = JSON.parse(readFileSync(join(repoFixtures, 'account_19000000_weth.json'), 'utf8'));
const storage = JSON.parse(readFileSync(join(repoFixtures, 'storage_19000000_weth_slot0.json'), 'utf8'));

const app = createApp();
const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

async function postAndReplay(label, body) {
  const verifyResp = await fetch(`${base}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const verifyBody = await verifyResp.json();
  console.log(`\n=== POST /verify (${label}) ===`);
  console.log('status:', verifyResp.status);
  console.log(JSON.stringify(verifyBody, null, 2));

  const receipt = verifyBody.receipt;
  const servicePub = createPublicKey(receipt.service_signature.public_key_pem);
  const check = verifyReceiptSignature(receipt, servicePub);
  console.log(`\n=== local replay (${label}) ===`);
  console.log(JSON.stringify({ recomputed_hash: check.recomputedHash, signature_valid: check.ok }, null, 2));

  const replayResp = await fetch(`${base}/replay/${receipt.receipt_id}`);
  console.log(`\n=== GET /replay/:id (${label}) ===`);
  console.log('status:', replayResp.status);
  console.log(await replayResp.text());

  console.log(`\n=== replay command (${label}) ===`);
  console.log(receipt.replay_command);
  if (!check.ok || receipt.decision !== 'pass') process.exitCode = 1;
}

try {
  await postAndReplay('account proof', {
    verifier: 'ethereum-mpt-fixture-verifier-v0',
    fixture_id: 'account_19000000_weth',
    proof_type: 'account',
    claimed_state_root: block.state_root,
    claimed_account_address: account.address,
  });

  await postAndReplay('storage proof', {
    verifier: 'ethereum-mpt-fixture-verifier-v0',
    fixture_id: 'storage_19000000_weth_slot0',
    proof_type: 'storage',
    claimed_storage_root: account.storage_root,
    claimed_account_address: storage.address,
    claimed_storage_slot: storage.slot,
    claimed_storage_value: storage.value,
  });
} finally {
  server.close();
}
