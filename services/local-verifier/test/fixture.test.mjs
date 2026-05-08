import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { createApp } from '../server.mjs';
import { canonicalJson } from '../lib/canonical.mjs';
import { verifyReceiptSignature, hashReceipt } from '../lib/receipt.mjs';
import { listVerifiers } from '../lib/registry.mjs';

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

function postVerify(body) {
  return fetch(`${baseUrl}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'paxiom-fixture-'));
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

test('GET /verifiers lists all three verifiers', async () => {
  const resp = await fetch(`${baseUrl}/verifiers`);
  assert.equal(resp.status, 200);
  const body = await resp.json();
  const ids = body.verifiers.map((v) => v.id).sort();
  assert.deepEqual(ids, ['demo-verifier-v0', 'fixture-proof-verifier-v0', 'signature-verifier-v0']);
  assert.equal(listVerifiers().length, 3);
});

test('valid fixture passes (claim=pass, recompute=pass)', async () => {
  const resp = await postVerify({
    verifier: 'fixture-proof-verifier-v0',
    fixture_id: 'fp-v0-canonical-pass',
    claimed_result: 'pass',
  });
  assert.equal(resp.status, 200);
  const body = await resp.json();
  const r = body.receipt;
  assert.equal(r.decision, 'pass');
  assert.equal(r.reason, 'fixture_valid');
  assert.equal(r.verifier_name, 'fixture-proof-verifier-v0');
  assert.equal(r.verifier_version, '0.1.0');
  assert.equal(body.details.recomputed_decision, 'pass');
  assert.equal(body.details.recomputed.matches, true);
});

test('caller correctly predicts a tampered fixture (claim=fail, recompute=fail) -> fixture_valid', async () => {
  const resp = await postVerify({
    verifier: 'fixture-proof-verifier-v0',
    fixture_id: 'fp-v0-canonical-fail',
    claimed_result: 'fail',
  });
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(body.receipt.decision, 'pass');
  assert.equal(body.receipt.reason, 'fixture_valid');
  assert.equal(body.details.recomputed_decision, 'fail');
});

test('wrong claimed_result -> fail/fixture_mismatch', async () => {
  const resp = await postVerify({
    verifier: 'fixture-proof-verifier-v0',
    fixture_id: 'fp-v0-canonical-pass',
    claimed_result: 'fail',
  });
  assert.equal(resp.status, 422);
  const body = await resp.json();
  assert.equal(body.receipt.decision, 'fail');
  assert.equal(body.receipt.reason, 'fixture_mismatch');
  assert.equal(body.details.recomputed_decision, 'pass');
  assert.equal(body.details.claimed_result, 'fail');
});

test('tampered fixture with claim=pass -> fail/fixture_mismatch', async () => {
  const resp = await postVerify({
    verifier: 'fixture-proof-verifier-v0',
    fixture_id: 'fp-v0-canonical-fail',
    claimed_result: 'pass',
  });
  assert.equal(resp.status, 422);
  const body = await resp.json();
  assert.equal(body.receipt.decision, 'fail');
  assert.equal(body.receipt.reason, 'fixture_mismatch');
  assert.equal(body.details.recomputed_decision, 'fail');
});

test('missing fixture -> fail/fixture_not_found', async () => {
  const resp = await postVerify({
    verifier: 'fixture-proof-verifier-v0',
    fixture_id: 'no-such-fixture',
    claimed_result: 'pass',
  });
  assert.equal(resp.status, 422);
  const body = await resp.json();
  assert.equal(body.receipt.decision, 'fail');
  assert.equal(body.receipt.reason, 'fixture_not_found');
});

test('malformed input (missing fixture_id) -> fail/malformed_input', async () => {
  const resp = await postVerify({
    verifier: 'fixture-proof-verifier-v0',
    claimed_result: 'pass',
  });
  assert.equal(resp.status, 422);
  const body = await resp.json();
  assert.equal(body.receipt.decision, 'fail');
  assert.equal(body.receipt.reason, 'malformed_input');
});

test('malformed input (claimed_result not pass/fail) -> fail/malformed_input', async () => {
  const resp = await postVerify({
    verifier: 'fixture-proof-verifier-v0',
    fixture_id: 'fp-v0-canonical-pass',
    claimed_result: 'maybe',
  });
  assert.equal(resp.status, 422);
  const body = await resp.json();
  assert.equal(body.receipt.decision, 'fail');
  assert.equal(body.receipt.reason, 'malformed_input');
});

test('malformed input (path traversal in fixture_id) -> fail/malformed_input', async () => {
  const resp = await postVerify({
    verifier: 'fixture-proof-verifier-v0',
    fixture_id: '../package',
    claimed_result: 'pass',
  });
  assert.equal(resp.status, 422);
  const body = await resp.json();
  assert.equal(body.receipt.decision, 'fail');
  assert.equal(body.receipt.reason, 'malformed_input');
});

test('receipt is stored and retrievable via GET /receipts/:id', async () => {
  const verifyResp = await postVerify({
    verifier: 'fixture-proof-verifier-v0',
    fixture_id: 'fp-v0-canonical-pass',
    claimed_result: 'pass',
  });
  const { receipt } = await verifyResp.json();
  const fetched = await fetch(`${baseUrl}/receipts/${receipt.receipt_id}`);
  assert.equal(fetched.status, 200);
  const stored = await fetched.json();
  assert.deepEqual(stored, receipt);
});

test('replay (HTTP + CLI) confirms hash and signature for a fixture receipt', async () => {
  const verifyResp = await postVerify({
    verifier: 'fixture-proof-verifier-v0',
    fixture_id: 'fp-v0-canonical-pass',
    claimed_result: 'pass',
  });
  const { receipt } = await verifyResp.json();

  const servicePub = createPublicKey(receipt.service_signature.public_key_pem);
  const check = verifyReceiptSignature(receipt, servicePub);
  assert.equal(check.ok, true);
  assert.equal(`0x${hashReceipt(receipt)}`, receipt.receipt_hash);

  const replay = await fetch(`${baseUrl}/replay/${receipt.receipt_id}`);
  const replayBody = await replay.json();
  assert.equal(replayBody.hash_matches, true);
  assert.equal(replayBody.signature_valid, true);

  const cli = spawnSync(process.execPath, [replayScript, receipt.receipt_id], {
    env: { ...process.env, PAXIOM_LOCAL_VERIFIER_DATA_DIR: dataDir },
    encoding: 'utf8',
  });
  assert.equal(cli.status, 0, cli.stderr);
  const report = JSON.parse(cli.stdout);
  assert.equal(report.signature_valid, true);
  assert.equal(report.hash_matches, true);
});

test('regression: demo-verifier-v0 still passes with matching sha256', async () => {
  const message = 'fixture-suite-demo-pass';
  const claimed_sha256 = createHash('sha256').update(message).digest('hex');
  const resp = await postVerify({ verifier: 'demo-verifier-v0', message, claimed_sha256 });
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(body.receipt.verifier_name, 'demo-verifier-v0');
  assert.equal(body.receipt.decision, 'pass');
});

test('regression: demo-verifier-v0 still fails on hash mismatch', async () => {
  const resp = await postVerify({ verifier: 'demo-verifier-v0', message: 'x', claimed_sha256: '0'.repeat(64) });
  assert.equal(resp.status, 422);
  const body = await resp.json();
  assert.equal(body.receipt.decision, 'fail');
});

test('regression: signature-verifier-v0 still passes with a valid ed25519 signature', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const payload = { hello: 'world' };
  const signature = cryptoSign(null, Buffer.from(canonicalJson(payload), 'utf8'), privateKey).toString('base64');
  const resp = await postVerify({
    verifier: 'signature-verifier-v0',
    payload,
    public_key_pem: publicKeyPem,
    signature,
    algorithm: 'ed25519',
  });
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(body.receipt.verifier_name, 'signature-verifier-v0');
  assert.equal(body.receipt.decision, 'pass');
  assert.equal(body.receipt.reason, 'signature_valid');
});

test('regression: signature-verifier-v0 still fails on a wrong signature', async () => {
  const { publicKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const resp = await postVerify({
    verifier: 'signature-verifier-v0',
    payload: { hello: 'world' },
    public_key_pem: publicKeyPem,
    signature: Buffer.alloc(64).toString('base64'),
    algorithm: 'ed25519',
  });
  assert.equal(resp.status, 422);
  const body = await resp.json();
  assert.equal(body.receipt.decision, 'fail');
  assert.equal(body.receipt.reason, 'signature_invalid');
});

test('three verifier types interleave in one audit chain via prior_receipt_hash', async () => {
  // demo
  const m = 'chain-3way';
  const claimed = createHash('sha256').update(m).digest('hex');
  const r1 = await (await postVerify({ verifier: 'demo-verifier-v0', message: m, claimed_sha256: claimed })).json();

  // signature
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pubPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const payload = { i: 'am', a: 'payload' };
  const sig = cryptoSign(null, Buffer.from(canonicalJson(payload), 'utf8'), privateKey).toString('base64');
  const r2 = await (await postVerify({
    verifier: 'signature-verifier-v0',
    payload,
    public_key_pem: pubPem,
    signature: sig,
    algorithm: 'ed25519',
  })).json();

  // fixture
  const r3 = await (await postVerify({
    verifier: 'fixture-proof-verifier-v0',
    fixture_id: 'fp-v0-canonical-pass',
    claimed_result: 'pass',
  })).json();

  assert.equal(r2.receipt.prior_receipt_hash, r1.receipt.receipt_hash);
  assert.equal(r3.receipt.prior_receipt_hash, r2.receipt.receipt_hash);
  assert.equal(r1.receipt.verifier_name, 'demo-verifier-v0');
  assert.equal(r2.receipt.verifier_name, 'signature-verifier-v0');
  assert.equal(r3.receipt.verifier_name, 'fixture-proof-verifier-v0');
});
