#!/usr/bin/env node
// Standalone replay tool. Reads a stored receipt by id, recomputes the
// canonical receipt_hash, and verifies the ed25519 signature against the
// service public key. Exits 0 on success, 1 on any mismatch.
//
//   node services/local-verifier/scripts/replay.mjs <receipt_id>

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicKey } from 'node:crypto';
import { verifyReceiptSignature } from '../lib/receipt.mjs';
import { resolveDataDir, resolveKeyPaths } from '../lib/paths.mjs';

function fail(msg) {
  console.error(`replay: ${msg}`);
  process.exit(1);
}

const receiptId = process.argv[2];
if (!receiptId) fail('usage: replay.mjs <receipt_id>');

const dataDir = resolveDataDir();
const receiptPath = join(dataDir, 'receipts', `${receiptId}.json`);
if (!existsSync(receiptPath)) fail(`receipt not found at ${receiptPath}`);

const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));

let publicKey;
if (receipt.service_signature && receipt.service_signature.public_key_pem) {
  publicKey = createPublicKey(receipt.service_signature.public_key_pem);
} else {
  const { publicPath } = resolveKeyPaths(dataDir);
  if (!existsSync(publicPath)) fail(`no public key embedded and ${publicPath} not found`);
  publicKey = createPublicKey(readFileSync(publicPath, 'utf8'));
}

const result = verifyReceiptSignature(receipt, publicKey);
const claimedHash = (receipt.receipt_hash || '').replace(/^0x/, '');

const report = {
  receipt_id: receipt.receipt_id,
  decision: receipt.decision,
  reason: receipt.reason,
  recomputed_hash: result.recomputedHash,
  stored_hash: claimedHash,
  hash_matches: result.recomputedHash === claimedHash,
  signature_valid: result.ok,
  replay_command: receipt.replay_command,
};
console.log(JSON.stringify(report, null, 2));
if (!result.ok) process.exit(1);
