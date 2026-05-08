// Local ed25519 service keypair. Generated on first run, persisted to disk.
// This is a developer key for the demo MVP. Do not use in production.

import { generateKeyPairSync, createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export function loadOrCreateKeypair(privatePath, publicPath) {
  if (existsSync(privatePath) && existsSync(publicPath)) {
    const privatePem = readFileSync(privatePath, 'utf8');
    const publicPem = readFileSync(publicPath, 'utf8');
    return {
      privateKey: createPrivateKey(privatePem),
      publicKey: createPublicKey(publicPem),
      privatePem,
      publicPem,
      created: false,
    };
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const publicPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  mkdirSync(dirname(privatePath), { recursive: true });
  writeFileSync(privatePath, privatePem, { mode: 0o600 });
  writeFileSync(publicPath, publicPem);
  return { privateKey, publicKey, privatePem, publicPem, created: true };
}

export function loadPublicKey(publicPath) {
  return createPublicKey(readFileSync(publicPath, 'utf8'));
}
