import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { deploymentMode, isStrictDeployment } from './deployment.mjs';

const DEFAULT_ARCHIVE_DIR = '.paxiom/proof-archive';
const ENCRYPTION_KEY_ENV = 'PAXIOM_PROOF_ARCHIVE_ENCRYPTION_KEY_BASE64';

export async function archiveEvidence({
  service,
  artifactType,
  payload,
  evidenceTags = [],
  request = {},
  mode = process.env.PAXIOM_PROOF_ARCHIVE_MODE || 'disabled',
  required = process.env.PAXIOM_PROOF_ARCHIVE_REQUIRED === '1',
  now = new Date(),
} = {}) {
  const normalizedMode = String(mode || 'disabled').trim().toLowerCase();
  const manifest = buildManifest({ service, artifactType, payload, evidenceTags, request, now });

  if (normalizedMode === 'disabled') {
    if (required || isStrictDeployment()) {
      throw new Error(`Paxiom proof archive is disabled in ${deploymentMode() || 'required'} mode`);
    }
    return auditRecord({
      status: 'archive_disabled',
      evidenceTags,
      archive: {
        mode: 'disabled',
        privacy: 'not_written',
        warehouse: archiveWarehouse(),
        storageClass: archiveStorageClass(),
        latencyClass: archiveLatencyClass(),
        manifestHash: manifest.manifestHash,
      },
    });
  }

  try {
    const bundle = encryptBundle({ manifest, payload });
    if (normalizedMode === 'local') {
      return await writeLocalArchive({ bundle, evidenceTags });
    }
    if (normalizedMode === 'arweave') {
      return await writeArweaveArchive({ bundle, evidenceTags });
    }
    throw new Error(`unsupported PAXIOM_PROOF_ARCHIVE_MODE '${mode}'`);
  } catch (e) {
    if (required || isStrictDeployment()) throw e;
    return auditRecord({
      status: 'archive_error',
      evidenceTags,
      archive: {
        mode: normalizedMode,
        privacy: 'encrypted',
        warehouse: archiveWarehouse(),
        storageClass: archiveStorageClass(),
        latencyClass: archiveLatencyClass(),
        manifestHash: manifest.manifestHash,
        error: e.message,
      },
    });
  }
}

function buildManifest({ service, artifactType, payload, evidenceTags, request, now }) {
  const minimalPayload = {
    block_number: payload?.block_number ?? null,
    block_hash: payload?.block_hash ?? null,
    state_root: payload?.state_root ?? null,
    address: payload?.address ?? null,
    slot: payload?.slot ?? null,
    value_hash: payload?.value ? sha256Hex(String(payload.value)) : null,
    verified: payload?.verified === true,
    source: payload?.source ?? null,
  };
  const manifest = {
    version: 1,
    createdAt: now.toISOString(),
    service,
    artifactType,
    evidenceTags,
    request,
    payload: minimalPayload,
      archivePolicy: {
        storage: 'arweave-compatible',
        privacy: 'encrypted-bundle',
        indexAuthority: 'paxiom',
        warehouse: archiveWarehouse(),
        storageClass: archiveStorageClass(),
        latencyClass: archiveLatencyClass(),
        truthAnchor: 'ethereum-state-root',
        rpcAuthority: false,
      },
  };
  const manifestHash = sha256Json(manifest);
  return { ...manifest, manifestHash };
}

function encryptBundle({ manifest, payload }) {
  const key = proofArchiveKey();
  const iv = randomBytes(12);
  const plaintext = canonicalJson({
    manifest,
    payload,
  });
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const bundle = {
    kind: 'paxiom-proof-archive-bundle',
    version: 1,
    manifest,
    encryption: {
      algorithm: 'aes-256-gcm',
      keyId: process.env.PAXIOM_PROOF_ARCHIVE_KEY_ID || 'paxiom-proof-archive-key',
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
    },
    payload: ciphertext.toString('base64'),
    plaintextSha256: sha256Hex(plaintext),
  };
  return {
    bundle,
    manifest,
    bundleSha256: sha256Json(bundle),
  };
}

async function writeLocalArchive({ bundle, evidenceTags }) {
  const dir = resolve(process.env.PAXIOM_PROOF_ARCHIVE_DIR || DEFAULT_ARCHIVE_DIR);
  await mkdir(dir, { recursive: true });
  const filename = `${bundle.manifest.manifestHash}.paxiom-proof.json`;
  const path = resolve(dir, filename);
  await writeFile(path, `${canonicalJson(bundle.bundle)}\n`, { mode: 0o600 });
  const aoMessageId = await maybeSendAoIndexMessage({
    manifest: bundle.manifest,
    storage: { mode: 'local', ref: `local:${bundle.manifest.manifestHash}` },
  });
  return auditRecord({
    status: 'written_local',
    evidenceTags,
    aoMessageId,
      archive: {
        mode: 'local',
        privacy: 'encrypted',
        warehouse: archiveWarehouse(),
        storageClass: archiveStorageClass(),
        latencyClass: archiveLatencyClass(),
        manifestHash: bundle.manifest.manifestHash,
        bundleSha256: sha256Json(bundle.bundle),
        storageRef: `local:${bundle.manifest.manifestHash}`,
      },
    });
}

async function writeArweaveArchive({ bundle, evidenceTags }) {
  const wallet = await loadArweaveWallet();
  const { default: Arweave } = await import('arweave');
  const arweave = Arweave.init({
    host: process.env.ARWEAVE_HOST || 'arweave.net',
    port: Number(process.env.ARWEAVE_PORT || 443),
    protocol: process.env.ARWEAVE_PROTOCOL || 'https',
  });
  const tx = await arweave.createTransaction({ data: canonicalJson(bundle.bundle) }, wallet);
  for (const tag of arweaveTags(bundle.manifest, evidenceTags)) {
    tx.addTag(tag.name, tag.value);
  }
  await arweave.transactions.sign(tx, wallet);
  const resp = await arweave.transactions.post(tx);
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`Arweave post failed: HTTP ${resp.status}`);
  }
  const aoMessageId = await maybeSendAoIndexMessage({
    manifest: bundle.manifest,
    storage: { mode: 'arweave', ref: tx.id },
  });
  return auditRecord({
    status: 'written_arweave',
    evidenceTags,
    arweaveTxId: tx.id,
    aoMessageId,
      archive: {
        mode: 'arweave',
        privacy: 'encrypted',
        warehouse: archiveWarehouse(),
        storageClass: archiveStorageClass(),
        latencyClass: archiveLatencyClass(),
        manifestHash: bundle.manifest.manifestHash,
        bundleSha256: sha256Json(bundle.bundle),
        storageRef: tx.id,
      },
  });
}

async function maybeSendAoIndexMessage({ manifest, storage }) {
  const processId = process.env.PAXIOM_AO_PROOF_ARCHIVE_PROCESS;
  if (!processId) return null;
  const wallet = await loadArweaveWallet();
  const { message, createDataItemSigner } = await import('@permaweb/aoconnect');
  return message({
    process: processId,
    signer: createDataItemSigner(wallet),
    tags: [
      { name: 'Action', value: 'IndexProofArchiveBundle' },
      { name: 'Service', value: String(manifest.service) },
      { name: 'Artifact-Type', value: String(manifest.artifactType) },
      { name: 'Manifest-Hash', value: manifest.manifestHash },
      { name: 'Storage-Mode', value: storage.mode },
      { name: 'Storage-Ref', value: storage.ref },
    ],
    data: canonicalJson({ manifest, storage }),
  });
}

function auditRecord({ status, evidenceTags, arweaveTxId = null, aoMessageId = null, archive }) {
  return {
    target: 'Paxiom Proof Archive',
    status,
    aoMessageId,
    arweaveTxId,
    evidenceTags,
    archive,
  };
}

function arweaveTags(manifest, evidenceTags) {
  return [
    { name: 'App-Name', value: 'Paxiom' },
    { name: 'Content-Type', value: 'application/json' },
    { name: 'Paxiom-Artifact', value: 'proof-archive-bundle' },
    { name: 'Paxiom-Service', value: String(manifest.service) },
    { name: 'Paxiom-Artifact-Type', value: String(manifest.artifactType) },
    { name: 'Paxiom-Manifest-Hash', value: manifest.manifestHash },
    { name: 'Paxiom-Privacy', value: 'encrypted' },
    ...evidenceTags.slice(0, 12).map((value, i) => ({ name: `Paxiom-Evidence-${i + 1}`, value: String(value) })),
  ];
}

function proofArchiveKey() {
  const raw = process.env[ENCRYPTION_KEY_ENV];
  if (!raw) throw new Error(`${ENCRYPTION_KEY_ENV} is required for encrypted proof archive writes`);
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error(`${ENCRYPTION_KEY_ENV} must decode to 32 bytes`);
  return key;
}

function archiveWarehouse() {
  return process.env.PAXIOM_PROOF_ARCHIVE_WAREHOUSE || 'operator-local';
}

function archiveStorageClass() {
  return process.env.PAXIOM_PROOF_ARCHIVE_STORAGE_CLASS || 'hot-local';
}

function archiveLatencyClass() {
  return process.env.PAXIOM_PROOF_ARCHIVE_LATENCY_CLASS || 'synchronous';
}

async function loadArweaveWallet() {
  if (process.env.PAXIOM_ARWEAVE_WALLET_JWK) {
    return JSON.parse(process.env.PAXIOM_ARWEAVE_WALLET_JWK);
  }
  if (process.env.PAXIOM_ARWEAVE_WALLET_JWK_PATH) {
    return JSON.parse(await readFile(process.env.PAXIOM_ARWEAVE_WALLET_JWK_PATH, 'utf8'));
  }
  throw new Error('PAXIOM_ARWEAVE_WALLET_JWK or PAXIOM_ARWEAVE_WALLET_JWK_PATH is required for Arweave/AO writes');
}

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

function sha256Json(value) {
  return sha256Hex(canonicalJson(value));
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}
