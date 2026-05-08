import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign, createHash, createPublicKey } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { createApp } from '../server.mjs';
import { canonicalJson } from '../lib/canonical.mjs';
import { verifyReceiptSignature, hashReceipt } from '../lib/receipt.mjs';
import { listVerifiers, DEFAULT_VERIFIER_ID } from '../lib/registry.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const replayScript = join(here, '..', 'scripts', 'replay.mjs');

let dataDir;
let server;
let baseUrl;
let signer;
let signerPubPem;

function listen(app) {
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
}

function signPayload(payload) {
  const bytes = Buffer.from(canonicalJson(payload), 'utf8');
  return cryptoSign(null, bytes, signer.privateKey).toString('base64');
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'paxiom-sigverifier-'));
  process.env.PAXIOM_LOCAL_VERIFIER_DATA_DIR = dataDir;
  const app = createApp({ dataDir });
  server = await listen(app);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  signer = generateKeyPairSync('ed25519');
  signerPubPem = signer.publicKey.export({ format: 'pem', type: 'spki' }).toString();
});

after(() => {
  server.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.PAXIOM_LOCAL_VERIFIER_DATA_DIR;
});

test('GET /verifiers includes signature-verifier-v0; default is demo', async () => {
  const resp = await fetch(`${baseUrl}/verifiers`);
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(body.default, 'demo-verifier-v0');
  const ids = body.verifiers.map((v) => v.id);
  assert.ok(ids.includes('demo-verifier-v0'));
  assert.ok(ids.includes('signature-verifier-v0'));
  assert.equal(DEFAULT_VERIFIER_ID, 'demo-verifier-v0');
  assert.ok(listVerifiers().some((v) => v.id === 'signature-verifier-v0'));
});

test('signature-verifier-v0: valid ed25519 signature passes and receipt is replayable', async () => {
  const payload = { hello: 'world', n: 42 };
  const signature = signPayload(payload);
  const resp = await fetch(`${baseUrl}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      verifier: 'signature-verifier-v0',
      payload,
      public_key_pem: signerPubPem,
      signature,
      algorithm: 'ed25519',
    }),
  });
  assert.equal(resp.status, 200);
  const body = await resp.json();
  const r = body.receipt;
  assert.equal(r.decision, 'pass');
  assert.equal(r.reason, 'signature_valid');
  assert.equal(r.verifier_name, 'signature-verifier-v0');
  assert.equal(r.verifier_version, '0.1.0');
  assert.match(r.receipt_hash, /^0x[0-9a-f]{64}$/);

  // Receipt chassis still verifiable end-to-end.
  const servicePub = createPublicKey(r.service_signature.public_key_pem);
  const check = verifyReceiptSignature(r, servicePub);
  assert.equal(check.ok, true);
  assert.equal(`0x${hashReceipt(r)}`, r.receipt_hash);

  // Replay endpoint agrees.
  const replay = await fetch(`${baseUrl}/replay/${r.receipt_id}`);
  const replayBody = await replay.json();
  assert.equal(replayBody.hash_matches, true);
  assert.equal(replayBody.signature_valid, true);

  // CLI replay agrees and exits 0.
  const cli = spawnSync(process.execPath, [replayScript, r.receipt_id], {
    env: { ...process.env, PAXIOM_LOCAL_VERIFIER_DATA_DIR: dataDir },
    encoding: 'utf8',
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).signature_valid, true);
});

test('signature-verifier-v0: invalid signature -> fail/signature_invalid (status 422)', async () => {
  const payload = { foo: 1 };
  const bogusSig = Buffer.alloc(64).toString('base64'); // 64 bytes of zero
  const resp = await fetch(`${baseUrl}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      verifier: 'signature-verifier-v0',
      payload,
      public_key_pem: signerPubPem,
      signature: bogusSig,
      algorithm: 'ed25519',
    }),
  });
  assert.equal(resp.status, 422);
  const body = await resp.json();
  assert.equal(body.receipt.decision, 'fail');
  assert.equal(body.receipt.reason, 'signature_invalid');
});

test('signature-verifier-v0: tampered payload -> fail/signature_invalid', async () => {
  const original = { user: 'alice', amount: 1 };
  const signature = signPayload(original);
  const tampered = { user: 'alice', amount: 1000000 };
  const resp = await fetch(`${baseUrl}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      verifier: 'signature-verifier-v0',
      payload: tampered,
      public_key_pem: signerPubPem,
      signature,
      algorithm: 'ed25519',
    }),
  });
  assert.equal(resp.status, 422);
  const body = await resp.json();
  assert.equal(body.receipt.decision, 'fail');
  assert.equal(body.receipt.reason, 'signature_invalid');
});

test('signature-verifier-v0: unsupported algorithm -> fail/unsupported_algorithm', async () => {
  const resp = await fetch(`${baseUrl}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      verifier: 'signature-verifier-v0',
      payload: { x: 1 },
      public_key_pem: signerPubPem,
      signature: 'AAAA',
      algorithm: 'rsa-pss',
    }),
  });
  assert.equal(resp.status, 422);
  const body = await resp.json();
  assert.equal(body.receipt.decision, 'fail');
  assert.equal(body.receipt.reason, 'unsupported_algorithm');
  assert.deepEqual(body.details.supported, ['ed25519']);
});

test('signature-verifier-v0: malformed input (missing signature) -> fail/malformed_input', async () => {
  const resp = await fetch(`${baseUrl}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      verifier: 'signature-verifier-v0',
      payload: { x: 1 },
      public_key_pem: signerPubPem,
      algorithm: 'ed25519',
    }),
  });
  assert.equal(resp.status, 422);
  const body = await resp.json();
  assert.equal(body.receipt.decision, 'fail');
  assert.equal(body.receipt.reason, 'malformed_input');
});

test('signature-verifier-v0: malformed public_key_pem -> fail/malformed_input', async () => {
  const resp = await fetch(`${baseUrl}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      verifier: 'signature-verifier-v0',
      payload: { x: 1 },
      public_key_pem: 'not a real PEM',
      signature: 'AAAA',
      algorithm: 'ed25519',
    }),
  });
  assert.equal(resp.status, 422);
  const body = await resp.json();
  assert.equal(body.receipt.decision, 'fail');
  assert.equal(body.receipt.reason, 'malformed_input');
});

test('unknown verifier id -> 400', async () => {
  const resp = await fetch(`${baseUrl}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ verifier: 'no-such-verifier', message: 'x', claimed_sha256: '0'.repeat(64) }),
  });
  assert.equal(resp.status, 400);
  const body = await resp.json();
  assert.equal(body.error, 'unknown verifier');
  assert.ok(body.available.includes('demo-verifier-v0'));
  assert.ok(body.available.includes('signature-verifier-v0'));
});

test('regression: demo-verifier-v0 with explicit verifier field still passes', async () => {
  const message = 'regression-pass';
  const claimed_sha256 = createHash('sha256').update(message).digest('hex');
  const resp = await fetch(`${baseUrl}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ verifier: 'demo-verifier-v0', message, claimed_sha256 }),
  });
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(body.receipt.verifier_name, 'demo-verifier-v0');
  assert.equal(body.receipt.decision, 'pass');
});

test('regression: demo-verifier-v0 without verifier field still fails on mismatch', async () => {
  const resp = await fetch(`${baseUrl}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'hello', claimed_sha256: '0'.repeat(64) }),
  });
  assert.equal(resp.status, 422);
  const body = await resp.json();
  assert.equal(body.receipt.verifier_name, 'demo-verifier-v0');
  assert.equal(body.receipt.decision, 'fail');
});

test('signature receipts and demo receipts coexist in audit log via prior_receipt_hash', async () => {
  // First receipt: demo
  const message = 'chain-1';
  const claimed = createHash('sha256').update(message).digest('hex');
  const r1 = await (await fetch(`${baseUrl}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ verifier: 'demo-verifier-v0', message, claimed_sha256: claimed }),
  })).json();

  // Second receipt: signature
  const payload = { chain: 'two' };
  const signature = signPayload(payload);
  const r2 = await (await fetch(`${baseUrl}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      verifier: 'signature-verifier-v0',
      payload,
      public_key_pem: signerPubPem,
      signature,
      algorithm: 'ed25519',
    }),
  })).json();

  assert.equal(r2.receipt.prior_receipt_hash, r1.receipt.receipt_hash);
  assert.equal(r1.receipt.verifier_name, 'demo-verifier-v0');
  assert.equal(r2.receipt.verifier_name, 'signature-verifier-v0');
});
