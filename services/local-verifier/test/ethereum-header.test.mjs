import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
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
const fixturesDir = join(here, '..', 'fixtures');
const goodFixture = JSON.parse(readFileSync(join(fixturesDir, 'eth-header-v0-good.json'), 'utf8'));
const tamperedFixture = JSON.parse(readFileSync(join(fixturesDir, 'eth-header-v0-tampered.json'), 'utf8'));

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
  dataDir = mkdtempSync(join(tmpdir(), 'paxiom-ethheader-'));
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

test('GET /verifiers includes the four foundational verifiers', async () => {
  const resp = await fetch(`${baseUrl}/verifiers`);
  assert.equal(resp.status, 200);
  const body = await resp.json();
  const ids = body.verifiers.map((v) => v.id);
  for (const expected of [
    'demo-verifier-v0',
    'signature-verifier-v0',
    'fixture-proof-verifier-v0',
    'ethereum-header-fixture-verifier-v0',
  ]) {
    assert.ok(ids.includes(expected), `missing ${expected}`);
  }
  assert.ok(listVerifiers().length >= 4);
});

test('valid header fixture passes (claim matches recomputed)', async () => {
  const resp = await postVerify({
    verifier: 'ethereum-header-fixture-verifier-v0',
    fixture_id: 'eth-header-v0-good',
    claimed_block_hash: goodFixture.block_hash,
  });
  assert.equal(resp.status, 200);
  const body = await resp.json();
  const r = body.receipt;
  assert.equal(r.decision, 'pass');
  assert.equal(r.reason, 'ethereum_header_valid');
  assert.equal(r.verifier_name, 'ethereum-header-fixture-verifier-v0');
  assert.equal(r.verifier_version, '0.1.0');
  assert.equal(body.details.fixture_consistent, true);
  assert.equal(body.details.recomputed_block_hash, goodFixture.block_hash.toLowerCase());
});

test('wrong claimed_block_hash -> fail/ethereum_header_mismatch', async () => {
  const resp = await postVerify({
    verifier: 'ethereum-header-fixture-verifier-v0',
    fixture_id: 'eth-header-v0-good',
    claimed_block_hash: '0x' + '00'.repeat(32),
  });
  assert.equal(resp.status, 422);
  const body = await resp.json();
  assert.equal(body.receipt.decision, 'fail');
  assert.equal(body.receipt.reason, 'ethereum_header_mismatch');
});

test('tampered fixture: caller trusts declared (wrong) hash -> ethereum_header_mismatch', async () => {
  // Caller naively passes the fixture's declared block_hash, which has been tampered.
  // The verifier recomputes from header bytes and surfaces the mismatch.
  const resp = await postVerify({
    verifier: 'ethereum-header-fixture-verifier-v0',
    fixture_id: 'eth-header-v0-tampered',
    claimed_block_hash: tamperedFixture.block_hash,
  });
  assert.equal(resp.status, 422);
  const body = await resp.json();
  assert.equal(body.receipt.decision, 'fail');
  assert.equal(body.receipt.reason, 'ethereum_header_mismatch');
  assert.equal(body.details.fixture_consistent, false);
});

test('tampered fixture: caller pre-computes correct hash -> ethereum_header_valid', async () => {
  // Demonstrates that the verifier's authority is the recomputation, not the
  // fixture's declared block_hash. A reviewer who RLP-encodes + keccaks the
  // header themselves can verify against the correct value even when the
  // fixture file declares a wrong hash.
  const resp = await postVerify({
    verifier: 'ethereum-header-fixture-verifier-v0',
    fixture_id: 'eth-header-v0-tampered',
    claimed_block_hash: goodFixture.block_hash,
  });
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(body.receipt.decision, 'pass');
  assert.equal(body.receipt.reason, 'ethereum_header_valid');
  assert.equal(body.details.fixture_consistent, false);
});

test('missing fixture -> fail/fixture_not_found', async () => {
  const resp = await postVerify({
    verifier: 'ethereum-header-fixture-verifier-v0',
    fixture_id: 'no-such-eth-fixture',
    claimed_block_hash: '0x' + '00'.repeat(32),
  });
  assert.equal(resp.status, 422);
  const body = await resp.json();
  assert.equal(body.receipt.decision, 'fail');
  assert.equal(body.receipt.reason, 'fixture_not_found');
});

test('malformed input (missing claimed_block_hash) -> fail/malformed_input', async () => {
  const resp = await postVerify({
    verifier: 'ethereum-header-fixture-verifier-v0',
    fixture_id: 'eth-header-v0-good',
  });
  assert.equal(resp.status, 422);
  const body = await resp.json();
  assert.equal(body.receipt.decision, 'fail');
  assert.equal(body.receipt.reason, 'malformed_input');
});

test('malformed input (claimed_block_hash not 32-byte hex) -> fail/malformed_input', async () => {
  const resp = await postVerify({
    verifier: 'ethereum-header-fixture-verifier-v0',
    fixture_id: 'eth-header-v0-good',
    claimed_block_hash: '0xnothex',
  });
  assert.equal(resp.status, 422);
  const body = await resp.json();
  assert.equal(body.receipt.reason, 'malformed_input');
});

test('malformed input (path traversal in fixture_id) -> fail/malformed_input', async () => {
  const resp = await postVerify({
    verifier: 'ethereum-header-fixture-verifier-v0',
    fixture_id: '../package',
    claimed_block_hash: '0x' + '00'.repeat(32),
  });
  assert.equal(resp.status, 422);
  const body = await resp.json();
  assert.equal(body.receipt.reason, 'malformed_input');
});

test('unsupported fixture (wrong fixture_kind) -> fail/unsupported_fixture', async () => {
  // fp-v0-canonical-pass exists but is fixture_kind="canonical-json-sha256-v0",
  // not "ethereum-block-header-v0".
  const resp = await postVerify({
    verifier: 'ethereum-header-fixture-verifier-v0',
    fixture_id: 'fp-v0-canonical-pass',
    claimed_block_hash: '0x' + '00'.repeat(32),
  });
  assert.equal(resp.status, 422);
  const body = await resp.json();
  assert.equal(body.receipt.decision, 'fail');
  assert.equal(body.receipt.reason, 'unsupported_fixture');
});

test('receipt is stored and retrievable via GET /receipts/:id', async () => {
  const verifyResp = await postVerify({
    verifier: 'ethereum-header-fixture-verifier-v0',
    fixture_id: 'eth-header-v0-good',
    claimed_block_hash: goodFixture.block_hash,
  });
  const { receipt } = await verifyResp.json();
  const fetched = await fetch(`${baseUrl}/receipts/${receipt.receipt_id}`);
  assert.equal(fetched.status, 200);
  const stored = await fetched.json();
  assert.deepEqual(stored, receipt);
});

test('replay (HTTP + CLI) confirms hash and signature for an ethereum-header receipt', async () => {
  const verifyResp = await postVerify({
    verifier: 'ethereum-header-fixture-verifier-v0',
    fixture_id: 'eth-header-v0-good',
    claimed_block_hash: goodFixture.block_hash,
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
  assert.equal(JSON.parse(cli.stdout).signature_valid, true);
});

test('regression: demo-verifier-v0 still passes with matching sha256', async () => {
  const message = 'eth-header-suite-demo-pass';
  const claimed_sha256 = createHash('sha256').update(message).digest('hex');
  const resp = await postVerify({ verifier: 'demo-verifier-v0', message, claimed_sha256 });
  assert.equal(resp.status, 200);
  assert.equal((await resp.json()).receipt.decision, 'pass');
});

test('regression: demo-verifier-v0 still fails on mismatch', async () => {
  const resp = await postVerify({ verifier: 'demo-verifier-v0', message: 'x', claimed_sha256: '0'.repeat(64) });
  assert.equal(resp.status, 422);
  assert.equal((await resp.json()).receipt.decision, 'fail');
});

test('regression: signature-verifier-v0 still passes', async () => {
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
  assert.equal((await resp.json()).receipt.reason, 'signature_valid');
});

test('regression: signature-verifier-v0 still fails on bogus signature', async () => {
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
  assert.equal((await resp.json()).receipt.reason, 'signature_invalid');
});

test('regression: fixture-proof-verifier-v0 still passes a known-good fixture', async () => {
  const resp = await postVerify({
    verifier: 'fixture-proof-verifier-v0',
    fixture_id: 'fp-v0-canonical-pass',
    claimed_result: 'pass',
  });
  assert.equal(resp.status, 200);
  assert.equal((await resp.json()).receipt.reason, 'fixture_valid');
});

test('regression: fixture-proof-verifier-v0 still fails a wrong claim', async () => {
  const resp = await postVerify({
    verifier: 'fixture-proof-verifier-v0',
    fixture_id: 'fp-v0-canonical-pass',
    claimed_result: 'fail',
  });
  assert.equal(resp.status, 422);
  assert.equal((await resp.json()).receipt.reason, 'fixture_mismatch');
});

test('four verifier types interleave in one audit chain via prior_receipt_hash', async () => {
  const m = 'four-way-chain';
  const claimed = createHash('sha256').update(m).digest('hex');
  const r1 = await (await postVerify({ verifier: 'demo-verifier-v0', message: m, claimed_sha256: claimed })).json();

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pubPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const payload = { four: 'way' };
  const sig = cryptoSign(null, Buffer.from(canonicalJson(payload), 'utf8'), privateKey).toString('base64');
  const r2 = await (await postVerify({
    verifier: 'signature-verifier-v0', payload, public_key_pem: pubPem, signature: sig, algorithm: 'ed25519',
  })).json();

  const r3 = await (await postVerify({
    verifier: 'fixture-proof-verifier-v0', fixture_id: 'fp-v0-canonical-pass', claimed_result: 'pass',
  })).json();

  const r4 = await (await postVerify({
    verifier: 'ethereum-header-fixture-verifier-v0',
    fixture_id: 'eth-header-v0-good',
    claimed_block_hash: goodFixture.block_hash,
  })).json();

  assert.equal(r2.receipt.prior_receipt_hash, r1.receipt.receipt_hash);
  assert.equal(r3.receipt.prior_receipt_hash, r2.receipt.receipt_hash);
  assert.equal(r4.receipt.prior_receipt_hash, r3.receipt.receipt_hash);
  assert.equal(r4.receipt.verifier_name, 'ethereum-header-fixture-verifier-v0');
});
