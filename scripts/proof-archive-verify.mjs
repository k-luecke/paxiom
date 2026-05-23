#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const dir = resolve(String(process.argv[2] || process.env.PAXIOM_PROOF_ARCHIVE_DIR || '.paxiom/proof-archive').trim());
const forbidden = [
  /plaintext-account-node/i,
  /plaintext-storage-node/i,
  /"account_proof"\s*:/i,
  /"storage_proof"\s*:/i,
  /"witness"\s*:/i,
];

let checked = 0;
let failed = 0;

for (const name of await readdir(dir)) {
  if (!name.endsWith('.paxiom-proof.json')) continue;
  const path = resolve(dir, name);
  const st = await stat(path);
  if (!st.isFile()) continue;
  checked++;
  try {
    await verifyBundle(path, name);
  } catch (e) {
    failed++;
    console.error(`FAIL ${path}: ${e.message}`);
  }
}

if (checked === 0) {
  console.error(`FAIL ${dir}: no .paxiom-proof.json bundles found`);
  process.exit(2);
}

if (failed > 0) {
  console.error(`proof archive verification failed: ${failed}/${checked} bundles invalid`);
  process.exit(1);
}

console.log(`proof archive verification ok: ${checked} bundle(s) checked in ${dir}`);

async function verifyBundle(path, name) {
  const raw = await readFile(path, 'utf8');
  for (const pattern of forbidden) {
    if (pattern.test(raw)) {
      throw new Error(`possible plaintext witness leak matched ${pattern}`);
    }
  }
  const bundle = JSON.parse(raw);
  if (bundle.kind !== 'paxiom-proof-archive-bundle') throw new Error('wrong bundle kind');
  if (bundle.version !== 1) throw new Error('unsupported bundle version');
  if (bundle.encryption?.algorithm !== 'aes-256-gcm') throw new Error('unexpected encryption algorithm');
  if (!bundle.manifest?.manifestHash) throw new Error('missing manifestHash');
  if (!/^[0-9a-f]{64}$/.test(bundle.manifest.manifestHash)) throw new Error('manifestHash is not sha256 hex');
  if (name !== `${bundle.manifest.manifestHash}.paxiom-proof.json`) {
    throw new Error(`filename does not match manifest hash (${bundle.manifest.manifestHash})`);
  }
  const expectedManifestHash = sha256Json(withoutManifestHash(bundle.manifest));
  if (bundle.manifest.manifestHash !== expectedManifestHash) {
    throw new Error('manifest hash drift');
  }
  if (!bundle.payload || typeof bundle.payload !== 'string') throw new Error('missing encrypted payload');
  if (!bundle.encryption.iv || !bundle.encryption.authTag) throw new Error('missing AES-GCM iv/authTag');
  if (bundle.manifest.archivePolicy?.rpcAuthority !== false) {
    throw new Error('archive manifest must explicitly set rpcAuthority:false');
  }
}

function withoutManifestHash(manifest) {
  const copy = { ...manifest };
  delete copy.manifestHash;
  return copy;
}

function sha256Json(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}
