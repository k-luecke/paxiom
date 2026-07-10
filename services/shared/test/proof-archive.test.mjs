import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { archiveEvidence } from '../proof-archive.mjs';

const TEST_KEY = Buffer.alloc(32, 7).toString('base64');

function withEnv(vars, fn) {
  const old = {};
  for (const key of Object.keys(vars)) old[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of Object.entries(old)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

test('proof archive disabled mode is explicit and not a durable write claim', async () => {
  await withEnv({
    PAXIOM_DEPLOYMENT_MODE: '',
    PAXIOM_PROOF_ARCHIVE_MODE: 'disabled',
    PAXIOM_PROOF_ARCHIVE_REQUIRED: '',
    PAXIOM_PROOF_ARCHIVE_WAREHOUSE: undefined,
    PAXIOM_PROOF_ARCHIVE_STORAGE_CLASS: undefined,
    PAXIOM_PROOF_ARCHIVE_LATENCY_CLASS: undefined,
  }, async () => {
    const audit = await archiveEvidence({
      service: 'A-201',
      artifactType: 'slot_storage_proof_packet',
      payload: { verified: true, block_number: 1, value: '0x01' },
      evidenceTags: ['service:A-201'],
    });
    assert.equal(audit.target, 'Paxiom Proof Archive');
    assert.equal(audit.status, 'archive_disabled');
    assert.equal(audit.archive.mode, 'disabled');
    assert.equal(audit.archive.privacy, 'not_written');
    assert.equal(audit.archive.warehouse, 'operator-local');
    assert.equal(audit.arweaveTxId, null);
    assert.equal(audit.aoMessageId, null);
  });
});

test('local proof archive writes encrypted bundle without plaintext witness material', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'paxiom-proof-archive-'));
  await withEnv({
    PAXIOM_DEPLOYMENT_MODE: '',
    PAXIOM_PROOF_ARCHIVE_MODE: 'local',
    PAXIOM_PROOF_ARCHIVE_DIR: dir,
    PAXIOM_PROOF_ARCHIVE_ENCRYPTION_KEY_BASE64: TEST_KEY,
    PAXIOM_PROOF_ARCHIVE_KEY_ID: 'test-key',
    PAXIOM_PROOF_ARCHIVE_WAREHOUSE: 'google-drive',
    PAXIOM_PROOF_ARCHIVE_STORAGE_CLASS: 'cold-warehouse',
    PAXIOM_PROOF_ARCHIVE_LATENCY_CLASS: 'async-minutes',
    PAXIOM_AO_PROOF_ARCHIVE_PROCESS: '',
  }, async () => {
    const audit = await archiveEvidence({
      service: 'A-205',
      artifactType: 'verified_historical_storage_state',
      payload: {
        verified: true,
        block_number: 19000000,
        block_hash: '0xabc',
        state_root: '0xdef',
        address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
        slot: '0x0',
        value: '0x1234',
        source: 'load.network',
        witness: {
          account_proof: ['plaintext-account-node'],
          storage_proof: ['plaintext-storage-node'],
        },
      },
      evidenceTags: ['service:A-205', 'block:19000000'],
    });

    assert.equal(audit.status, 'written_local');
    assert.equal(audit.archive.mode, 'local');
    assert.equal(audit.archive.privacy, 'encrypted');
    assert.equal(audit.archive.warehouse, 'google-drive');
    assert.equal(audit.archive.storageClass, 'cold-warehouse');
    assert.equal(audit.archive.latencyClass, 'async-minutes');
    assert.match(audit.archive.manifestHash, /^[0-9a-f]{64}$/);
    assert.match(audit.archive.bundleSha256, /^[0-9a-f]{64}$/);

    const path = join(dir, `${audit.archive.manifestHash}.paxiom-proof.json`);
    assert.equal(existsSync(path), true);
    const raw = await readFile(path, 'utf8');
    assert.doesNotMatch(raw, /plaintext-account-node/);
    assert.doesNotMatch(raw, /plaintext-storage-node/);
    assert.match(raw, /"algorithm":"aes-256-gcm"/);
    assert.match(raw, /"Paxiom Proof Archive"|paxiom-proof-archive-bundle/);
  });
});
