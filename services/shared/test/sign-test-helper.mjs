// Shared test helper: ensures an ephemeral ed25519 signing key is available
// to createServiceEnvelope. Mandatory signing (audit H-01, issue #12) means
// tests must provide a real key; we generate one per test process.

import { generateKeyPairSync } from 'node:crypto';

let configured = false;

export function setupResponseSigningKey() {
  if (configured) return;
  if (!process.env.PAXIOM_RESPONSE_SIGNING_PRIVATE_KEY_PEM) {
    const { privateKey } = generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    process.env.PAXIOM_RESPONSE_SIGNING_PRIVATE_KEY_PEM = privateKey;
    process.env.PAXIOM_RESPONSE_SIGNING_KEY_ID = 'paxiom-test-ephemeral';
  }
  configured = true;
}
