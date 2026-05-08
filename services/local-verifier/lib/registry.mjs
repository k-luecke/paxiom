// Verifier registry.
//
// Purpose: prove the receipt chassis can host more than one verifier
// without changing the receipt/replay contract.
//
// Each entry exposes:
//   { id, name, version, verify(input) -> { decision, reason, input_hash,
//     output_hash, details, invalid? } }
//
// demo-verifier-v0 is a permanent regression baseline. Do not mutate or
// replace it. New verifiers land *beside* it.

import * as demo from './verifier.mjs';
import * as signatureV0 from './verifiers/signature.mjs';
import * as fixtureProofV0 from './verifiers/fixture-proof.mjs';
import * as ethereumHeaderV0 from './verifiers/ethereum-header.mjs';

export const DEFAULT_VERIFIER_ID = demo.VERIFIER_NAME;

const ENTRIES = [
  {
    id: demo.VERIFIER_NAME,
    name: demo.VERIFIER_NAME,
    version: demo.VERIFIER_VERSION,
    verify: demo.verify,
  },
  {
    id: signatureV0.VERIFIER_NAME,
    name: signatureV0.VERIFIER_NAME,
    version: signatureV0.VERIFIER_VERSION,
    verify: signatureV0.verify,
  },
  {
    id: fixtureProofV0.VERIFIER_NAME,
    name: fixtureProofV0.VERIFIER_NAME,
    version: fixtureProofV0.VERIFIER_VERSION,
    verify: fixtureProofV0.verify,
  },
  {
    id: ethereumHeaderV0.VERIFIER_NAME,
    name: ethereumHeaderV0.VERIFIER_NAME,
    version: ethereumHeaderV0.VERIFIER_VERSION,
    verify: ethereumHeaderV0.verify,
  },
];

const BY_ID = new Map(ENTRIES.map((e) => [e.id, e]));

export function listVerifiers() {
  return ENTRIES.map(({ id, name, version }) => ({ id, name, version }));
}

export function getVerifier(id) {
  return BY_ID.get(id) || null;
}

export function resolveVerifierId(requestBody) {
  if (requestBody && typeof requestBody.verifier === 'string' && requestBody.verifier.length > 0) {
    return requestBody.verifier;
  }
  return DEFAULT_VERIFIER_ID;
}
