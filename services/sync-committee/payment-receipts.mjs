import { canonicalJson, sha256Hex } from './platform-signature.mjs';

export function paymentPayloadHash(paymentPayload) {
  return sha256Hex(canonicalJson(paymentPayload));
}

export function receiptCacheKey({ paymentPayload }) {
  return paymentPayloadHash(paymentPayload);
}
