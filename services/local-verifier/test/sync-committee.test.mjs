import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  createHash, createPublicKey, generateKeyPairSync, sign as cryptoSign,
} from 'node:crypto';
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
const localFixturesDir = join(here, '..', 'fixtures');
const repoFixturesDir = join(here, '..', '..', '..', 'load-network', 'fixtures');

const goodSc = JSON.parse(readFileSync(join(localFixturesDir, 'sc-v0-period-1041-good.json'), 'utf8'));
const tamperedSc = JSON.parse(readFileSync(join(localFixturesDir, 'sc-v0-period-1041-tampered.json'), 'utf8'));

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
  dataDir = mkdtempSync(join(tmpdir(), 'paxiom-sc-data-'));
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

test('GET /verifiers includes all six foundational verifiers', async () => {
  const resp = await fetch(`${baseUrl}/verifiers`);
  assert.equal(resp.status, 200);
  const ids = (await resp.json()).verifiers.map((v) => v.id);
  for (const expected of [
    'demo-verifier-v0',
    'signature-verifier-v0',
    'fixture-proof-verifier-v0',
    'ethereum-header-fixture-verifier-v0',
    'ethereum-mpt-fixture-verifier-v0',
    'sync-committee-fixture-verifier-v0',
  ]) {
    assert.ok(ids.includes(expected), `missing ${expected}`);
  }
  assert.ok(listVerifiers().length >= 6);
});

test('valid sync-committee fixture passes; bls_aggregate_verified is false (v0 limitation)', async () => {
  const resp = await postVerify({
    verifier: 'sync-committee-fixture-verifier-v0',
    fixture_id: goodSc.fixture_id,
    claimed_header_root: goodSc.block_root,
    claimed_participation: goodSc.expected.participation,
  });
  assert.equal(resp.status, 200);
  const body = await resp.json();
  const r = body.receipt;
  assert.equal(r.decision, 'pass');
  assert.equal(r.reason, 'sync_committee_valid');
  assert.equal(r.verifier_name, 'sync-committee-fixture-verifier-v0');
  assert.equal(r.verifier_version, '0.1.0');
  assert.equal(body.details.fixture_internally_consistent, true);
  // v0 explicitly does NOT verify the BLS aggregate.
  assert.equal(body.details.bls_aggregate_verified, false);
  assert.equal(body.details.recomputed.signing_root, goodSc.expected.signing_root.toLowerCase());
  assert.equal(body.details.recomputed.participation, goodSc.expected.participation);
});

test('wrong claimed_header_root -> fail/header_root_mismatch', async () => {
  const resp = await postVerify({
    verifier: 'sync-committee-fixture-verifier-v0',
    fixture_id: goodSc.fixture_id,
    claimed_header_root: '0x' + 'ee'.repeat(32),
    claimed_participation: goodSc.expected.participation,
  });
  assert.equal(resp.status, 422);
  const body = await resp.json();
  assert.equal(body.receipt.decision, 'fail');
  assert.equal(body.receipt.reason, 'header_root_mismatch');
});

test('wrong claimed_participation -> fail/participation_mismatch', async () => {
  const resp = await postVerify({
    verifier: 'sync-committee-fixture-verifier-v0',
    fixture_id: goodSc.fixture_id,
    claimed_header_root: goodSc.block_root,
    claimed_participation: 0,
  });
  assert.equal(resp.status, 422);
  const body = await resp.json();
  assert.equal(body.receipt.reason, 'participation_mismatch');
});

test('tampered fixture (declared signing_root inconsistent with recompute) -> fail/sync_committee_invalid', async () => {
  const resp = await postVerify({
    verifier: 'sync-committee-fixture-verifier-v0',
    fixture_id: tamperedSc.fixture_id,
    claimed_header_root: tamperedSc.block_root,
    claimed_participation: tamperedSc.expected.participation,
  });
  assert.equal(resp.status, 422);
  const body = await resp.json();
  assert.equal(body.receipt.reason, 'sync_committee_invalid');
  assert.equal(body.details.fixture_internally_consistent, false);
});

test('malformed input (missing claimed_participation) -> fail/malformed_input', async () => {
  const resp = await postVerify({
    verifier: 'sync-committee-fixture-verifier-v0',
    fixture_id: goodSc.fixture_id,
    claimed_header_root: goodSc.block_root,
  });
  assert.equal(resp.status, 422);
  assert.equal((await resp.json()).receipt.reason, 'malformed_input');
});

test('malformed input (negative claimed_participation) -> fail/malformed_input', async () => {
  const resp = await postVerify({
    verifier: 'sync-committee-fixture-verifier-v0',
    fixture_id: goodSc.fixture_id,
    claimed_header_root: goodSc.block_root,
    claimed_participation: -1,
  });
  assert.equal(resp.status, 422);
  assert.equal((await resp.json()).receipt.reason, 'malformed_input');
});

test('malformed input (claimed_header_root not 32-byte hex) -> fail/malformed_input', async () => {
  const resp = await postVerify({
    verifier: 'sync-committee-fixture-verifier-v0',
    fixture_id: goodSc.fixture_id,
    claimed_header_root: '0xnope',
    claimed_participation: 1,
  });
  assert.equal(resp.status, 422);
  assert.equal((await resp.json()).receipt.reason, 'malformed_input');
});

test('malformed input (path traversal in fixture_id) -> fail/malformed_input', async () => {
  const resp = await postVerify({
    verifier: 'sync-committee-fixture-verifier-v0',
    fixture_id: '../package',
    claimed_header_root: goodSc.block_root,
    claimed_participation: 1,
  });
  assert.equal(resp.status, 422);
  assert.equal((await resp.json()).receipt.reason, 'malformed_input');
});

test('missing fixture -> fail/fixture_not_found', async () => {
  const resp = await postVerify({
    verifier: 'sync-committee-fixture-verifier-v0',
    fixture_id: 'no-such-sc-fixture',
    claimed_header_root: goodSc.block_root,
    claimed_participation: 1,
  });
  assert.equal(resp.status, 422);
  assert.equal((await resp.json()).receipt.reason, 'fixture_not_found');
});

test('unsupported fixture (canonical-json fixture used here) -> fail/unsupported_fixture', async () => {
  const resp = await postVerify({
    verifier: 'sync-committee-fixture-verifier-v0',
    fixture_id: 'fp-v0-canonical-pass',
    claimed_header_root: goodSc.block_root,
    claimed_participation: 1,
  });
  assert.equal(resp.status, 422);
  assert.equal((await resp.json()).receipt.reason, 'unsupported_fixture');
});

test('receipt is stored and retrievable via GET /receipts/:id', async () => {
  const verifyResp = await postVerify({
    verifier: 'sync-committee-fixture-verifier-v0',
    fixture_id: goodSc.fixture_id,
    claimed_header_root: goodSc.block_root,
    claimed_participation: goodSc.expected.participation,
  });
  const { receipt } = await verifyResp.json();
  const fetched = await fetch(`${baseUrl}/receipts/${receipt.receipt_id}`);
  assert.equal(fetched.status, 200);
  assert.deepEqual(await fetched.json(), receipt);
});

test('replay (HTTP + CLI) confirms hash and signature for a sync-committee receipt', async () => {
  const verifyResp = await postVerify({
    verifier: 'sync-committee-fixture-verifier-v0',
    fixture_id: goodSc.fixture_id,
    claimed_header_root: goodSc.block_root,
    claimed_participation: goodSc.expected.participation,
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

// Regression checks for the prior five verifiers — file unchanged, behavior unchanged.

test('regression: demo-verifier-v0 still passes', async () => {
  const message = 'sc-suite-demo-pass';
  const claimed_sha256 = createHash('sha256').update(message).digest('hex');
  const resp = await postVerify({ verifier: 'demo-verifier-v0', message, claimed_sha256 });
  assert.equal(resp.status, 200);
  assert.equal((await resp.json()).receipt.decision, 'pass');
});

test('regression: demo-verifier-v0 still fails on mismatch', async () => {
  const resp = await postVerify({ verifier: 'demo-verifier-v0', message: 'x', claimed_sha256: '0'.repeat(64) });
  assert.equal(resp.status, 422);
});

test('regression: signature-verifier-v0 still passes', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const payload = { hello: 'world' };
  const signature = cryptoSign(null, Buffer.from(canonicalJson(payload), 'utf8'), privateKey).toString('base64');
  const resp = await postVerify({
    verifier: 'signature-verifier-v0', payload, public_key_pem: publicKeyPem, signature, algorithm: 'ed25519',
  });
  assert.equal(resp.status, 200);
  assert.equal((await resp.json()).receipt.reason, 'signature_valid');
});

test('regression: fixture-proof-verifier-v0 still passes', async () => {
  const resp = await postVerify({
    verifier: 'fixture-proof-verifier-v0', fixture_id: 'fp-v0-canonical-pass', claimed_result: 'pass',
  });
  assert.equal(resp.status, 200);
  assert.equal((await resp.json()).receipt.reason, 'fixture_valid');
});

test('regression: ethereum-header-fixture-verifier-v0 still passes', async () => {
  const headerFixture = JSON.parse(readFileSync(join(localFixturesDir, 'eth-header-v0-good.json'), 'utf8'));
  const resp = await postVerify({
    verifier: 'ethereum-header-fixture-verifier-v0',
    fixture_id: 'eth-header-v0-good',
    claimed_block_hash: headerFixture.block_hash,
  });
  assert.equal(resp.status, 200);
  assert.equal((await resp.json()).receipt.reason, 'ethereum_header_valid');
});

test('regression: ethereum-mpt-fixture-verifier-v0 still passes (account proof)', async () => {
  const block = JSON.parse(readFileSync(join(repoFixturesDir, 'block_19000000.json'), 'utf8'));
  const acct = JSON.parse(readFileSync(join(repoFixturesDir, 'account_19000000_weth.json'), 'utf8'));
  const resp = await postVerify({
    verifier: 'ethereum-mpt-fixture-verifier-v0',
    fixture_id: 'account_19000000_weth',
    proof_type: 'account',
    claimed_state_root: block.state_root,
    claimed_account_address: acct.address,
  });
  assert.equal(resp.status, 200);
  assert.equal((await resp.json()).receipt.reason, 'mpt_account_proof_valid');
});

test('six verifier types interleave in one audit chain via prior_receipt_hash', async () => {
  const m = 'six-way-chain';
  const claimed = createHash('sha256').update(m).digest('hex');
  const r1 = await (await postVerify({ verifier: 'demo-verifier-v0', message: m, claimed_sha256: claimed })).json();

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pubPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const payload = { six: 'way' };
  const sig = cryptoSign(null, Buffer.from(canonicalJson(payload), 'utf8'), privateKey).toString('base64');
  const r2 = await (await postVerify({
    verifier: 'signature-verifier-v0', payload, public_key_pem: pubPem, signature: sig, algorithm: 'ed25519',
  })).json();

  const r3 = await (await postVerify({
    verifier: 'fixture-proof-verifier-v0', fixture_id: 'fp-v0-canonical-pass', claimed_result: 'pass',
  })).json();

  const headerFixture = JSON.parse(readFileSync(join(localFixturesDir, 'eth-header-v0-good.json'), 'utf8'));
  const r4 = await (await postVerify({
    verifier: 'ethereum-header-fixture-verifier-v0',
    fixture_id: 'eth-header-v0-good',
    claimed_block_hash: headerFixture.block_hash,
  })).json();

  const block = JSON.parse(readFileSync(join(repoFixturesDir, 'block_19000000.json'), 'utf8'));
  const acct = JSON.parse(readFileSync(join(repoFixturesDir, 'account_19000000_weth.json'), 'utf8'));
  const r5 = await (await postVerify({
    verifier: 'ethereum-mpt-fixture-verifier-v0',
    fixture_id: 'account_19000000_weth',
    proof_type: 'account',
    claimed_state_root: block.state_root,
    claimed_account_address: acct.address,
  })).json();

  const r6 = await (await postVerify({
    verifier: 'sync-committee-fixture-verifier-v0',
    fixture_id: goodSc.fixture_id,
    claimed_header_root: goodSc.block_root,
    claimed_participation: goodSc.expected.participation,
  })).json();

  assert.equal(r2.receipt.prior_receipt_hash, r1.receipt.receipt_hash);
  assert.equal(r3.receipt.prior_receipt_hash, r2.receipt.receipt_hash);
  assert.equal(r4.receipt.prior_receipt_hash, r3.receipt.receipt_hash);
  assert.equal(r5.receipt.prior_receipt_hash, r4.receipt.receipt_hash);
  assert.equal(r6.receipt.prior_receipt_hash, r5.receipt.receipt_hash);
  assert.equal(r6.receipt.verifier_name, 'sync-committee-fixture-verifier-v0');
});
