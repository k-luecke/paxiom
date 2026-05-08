// Receipt construction, hashing, and signing.
//
// receipt_hash is computed over every field in the receipt EXCEPT
// receipt_hash and service_signature, using canonical JSON.
// The signature is over the receipt_hash bytes.

import { createHash, randomUUID, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import { canonicalJson } from './canonical.mjs';

export const SERVICE_NAME = 'paxiom-local-verifier';

export function buildReceipt({
  verifierName,
  verifierVersion,
  decision,
  reason,
  inputHash,
  outputHash,
  priorReceiptHash = null,
  timestamp,
  receiptId,
  replayCommandTemplate,
}) {
  const id = receiptId || randomUUID();
  const ts = timestamp || new Date().toISOString();
  const replayCommand = replayCommandTemplate.replace('{receipt_id}', id);
  return {
    receipt_id: id,
    timestamp: ts,
    service_name: SERVICE_NAME,
    verifier_name: verifierName,
    verifier_version: verifierVersion,
    input_hash: inputHash,
    output_hash: outputHash,
    decision,
    reason,
    replay_command: replayCommand,
    prior_receipt_hash: priorReceiptHash,
  };
}

export function hashReceipt(receiptCore) {
  const subset = stripSignedFields(receiptCore);
  return sha256Hex(canonicalJson(subset));
}

export function signReceipt(receiptCore, privateKey, publicKeyPem, keyId = 'paxiom-local-verifier-dev') {
  const receiptHash = hashReceipt(receiptCore);
  const signature = cryptoSign(null, Buffer.from(receiptHash, 'hex'), privateKey).toString('base64');
  return {
    ...receiptCore,
    receipt_hash: `0x${receiptHash}`,
    service_signature: {
      algorithm: 'ed25519',
      key_id: keyId,
      public_key_pem: publicKeyPem,
      signature,
    },
  };
}

export function verifyReceiptSignature(receipt, publicKey) {
  const recomputedHash = hashReceipt(receipt);
  const claimedHash = (receipt.receipt_hash || '').replace(/^0x/, '');
  if (recomputedHash !== claimedHash) {
    return { ok: false, reason: 'receipt_hash does not match recomputed canonical hash', recomputedHash };
  }
  if (!receipt.service_signature || !receipt.service_signature.signature) {
    return { ok: false, reason: 'receipt has no service_signature' };
  }
  const ok = cryptoVerify(
    null,
    Buffer.from(recomputedHash, 'hex'),
    publicKey,
    Buffer.from(receipt.service_signature.signature, 'base64'),
  );
  return ok
    ? { ok: true, recomputedHash }
    : { ok: false, reason: 'signature does not validate against provided public key', recomputedHash };
}

function stripSignedFields(receipt) {
  const { receipt_hash: _h, service_signature: _s, ...rest } = receipt;
  return rest;
}

function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}
