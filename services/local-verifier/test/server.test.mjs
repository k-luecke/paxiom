import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { createApp } from '../server.mjs';
import { verifyReceiptSignature, hashReceipt, buildReceipt } from '../lib/receipt.mjs';
import { sha256Hex, verify as verifyDemo } from '../lib/verifier.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const replayScript = join(here, '..', 'scripts', 'replay.mjs');

let dataDir;
let server;
let baseUrl;

function listen(app) {
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'paxiom-local-verifier-'));
  process.env.PAXIOM_LOCAL_VERIFIER_DATA_DIR = dataDir;
  const app = createApp({ dataDir });
  server = await listen(app);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.PAXIOM_LOCAL_VERIFIER_DATA_DIR;
});

test('GET /health returns ok', async () => {
  const resp = await fetch(`${baseUrl}/health`);
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(body.ok, true);
});

test('POST /verify with matching sha256 returns pass receipt', async () => {
  const message = 'hello';
  const claimed_sha256 = createHash('sha256').update(message).digest('hex');
  const resp = await fetch(`${baseUrl}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, claimed_sha256 }),
  });
  assert.equal(resp.status, 200);
  const body = await resp.json();
  const r = body.receipt;
  assert.equal(r.decision, 'pass');
  assert.equal(r.verifier_name, 'demo-verifier-v0');
  assert.match(r.receipt_hash, /^0x[0-9a-f]{64}$/);
  assert.ok(r.service_signature.signature.length > 0);
  assert.ok(r.replay_command.includes(r.receipt_id));
});

test('POST /verify with mismatched sha256 returns fail receipt (status 422)', async () => {
  const resp = await fetch(`${baseUrl}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'hello', claimed_sha256: '0'.repeat(64) }),
  });
  assert.equal(resp.status, 422);
  const body = await resp.json();
  assert.equal(body.receipt.decision, 'fail');
});

test('POST /verify with malformed claimed_sha256 returns 400', async () => {
  const resp = await fetch(`${baseUrl}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'hello', claimed_sha256: 'not-hex' }),
  });
  assert.equal(resp.status, 400);
});

test('GET /receipts/:id returns the same signed receipt', async () => {
  const message = 'roundtrip';
  const claimed_sha256 = createHash('sha256').update(message).digest('hex');
  const verifyResp = await fetch(`${baseUrl}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, claimed_sha256 }),
  });
  const { receipt } = await verifyResp.json();

  const fetched = await fetch(`${baseUrl}/receipts/${receipt.receipt_id}`);
  assert.equal(fetched.status, 200);
  const stored = await fetched.json();
  assert.deepEqual(stored, receipt);
});

test('receipt_hash is deterministic and recomputable', async () => {
  const message = 'deterministic';
  const claimed_sha256 = createHash('sha256').update(message).digest('hex');
  const resp = await fetch(`${baseUrl}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, claimed_sha256 }),
  });
  const { receipt } = await resp.json();
  const recomputed = hashReceipt(receipt);
  assert.equal(`0x${recomputed}`, receipt.receipt_hash);
});

test('embedded public key validates the receipt signature', async () => {
  const message = 'sign me';
  const claimed_sha256 = createHash('sha256').update(message).digest('hex');
  const resp = await fetch(`${baseUrl}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, claimed_sha256 }),
  });
  const { receipt } = await resp.json();
  const publicKey = createPublicKey(receipt.service_signature.public_key_pem);
  const check = verifyReceiptSignature(receipt, publicKey);
  assert.equal(check.ok, true);
});

test('signature check fails when receipt is tampered', async () => {
  const message = 'tamper';
  const claimed_sha256 = createHash('sha256').update(message).digest('hex');
  const resp = await fetch(`${baseUrl}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, claimed_sha256 }),
  });
  const { receipt } = await resp.json();
  const tampered = { ...receipt, decision: receipt.decision === 'pass' ? 'fail' : 'pass' };
  const publicKey = createPublicKey(receipt.service_signature.public_key_pem);
  const check = verifyReceiptSignature(tampered, publicKey);
  assert.equal(check.ok, false);
});

test('GET /replay/:id reports hash and signature both valid', async () => {
  const message = 'replay-endpoint';
  const claimed_sha256 = createHash('sha256').update(message).digest('hex');
  const resp = await fetch(`${baseUrl}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, claimed_sha256 }),
  });
  const { receipt } = await resp.json();
  const replay = await fetch(`${baseUrl}/replay/${receipt.receipt_id}`);
  assert.equal(replay.status, 200);
  const body = await replay.json();
  assert.equal(body.hash_matches, true);
  assert.equal(body.signature_valid, true);
  assert.ok(body.replay_command.includes(receipt.receipt_id));
});

test('replay.mjs CLI exits 0 and verifies a real stored receipt', async () => {
  const message = 'cli-replay';
  const claimed_sha256 = createHash('sha256').update(message).digest('hex');
  const resp = await fetch(`${baseUrl}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, claimed_sha256 }),
  });
  const { receipt } = await resp.json();

  const result = spawnSync(process.execPath, [replayScript, receipt.receipt_id], {
    env: { ...process.env, PAXIOM_LOCAL_VERIFIER_DATA_DIR: dataDir },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `replay.mjs failed: ${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.signature_valid, true);
  assert.equal(report.hash_matches, true);
  assert.equal(report.receipt_id, receipt.receipt_id);
});

test('audit log appends one JSONL line per verification', async () => {
  const auditPath = join(dataDir, 'audit.log.jsonl');
  const before = existsSync(auditPath) ? readFileSync(auditPath, 'utf8').split('\n').filter(Boolean).length : 0;
  const message = 'audit';
  const claimed_sha256 = createHash('sha256').update(message).digest('hex');
  await fetch(`${baseUrl}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, claimed_sha256 }),
  });
  const after = readFileSync(auditPath, 'utf8').split('\n').filter(Boolean).length;
  assert.equal(after, before + 1);
});

test('verifier unit: matching hashes yield pass with non-null hashes', () => {
  const message = 'unit';
  const claimed_sha256 = sha256Hex(message);
  const r = verifyDemo({ message, claimed_sha256 });
  assert.equal(r.decision, 'pass');
  assert.match(r.input_hash, /^[0-9a-f]{64}$/);
  assert.match(r.output_hash, /^[0-9a-f]{64}$/);
});

test('buildReceipt + hashReceipt is stable for identical inputs', () => {
  const args = {
    verifierName: 'demo-verifier-v0',
    verifierVersion: '0.1.0',
    decision: 'pass',
    reason: 'ok',
    inputHash: 'a'.repeat(64),
    outputHash: 'b'.repeat(64),
    priorReceiptHash: null,
    timestamp: '2026-01-01T00:00:00.000Z',
    receiptId: 'fixed-id',
    replayCommandTemplate: 'replay {receipt_id}',
  };
  const a = buildReceipt(args);
  const b = buildReceipt(args);
  assert.equal(hashReceipt(a), hashReceipt(b));
});
