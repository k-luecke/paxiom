import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
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
const repoFixturesDir = join(here, '..', '..', '..', 'load-network', 'fixtures');
const localFixturesDir = join(here, '..', 'fixtures');

// Loaded once for cross-checking.
const block = JSON.parse(readFileSync(join(repoFixturesDir, 'block_19000000.json'), 'utf8'));
const account = JSON.parse(readFileSync(join(repoFixturesDir, 'account_19000000_weth.json'), 'utf8'));
const storage = JSON.parse(readFileSync(join(repoFixturesDir, 'storage_19000000_weth_slot0.json'), 'utf8'));

let dataDir;
let mptFixtureDir;
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
  dataDir = mkdtempSync(join(tmpdir(), 'paxiom-mpt-data-'));
  mptFixtureDir = mkdtempSync(join(tmpdir(), 'paxiom-mpt-fix-'));
  // Copy real MPT fixtures over so the test sandbox has the same data.
  for (const f of ['block_19000000.json', 'account_19000000_weth.json', 'storage_19000000_weth_slot0.json']) {
    copyFileSync(join(repoFixturesDir, f), join(mptFixtureDir, f));
  }
  // Also copy a non-MPT fixture so we can exercise unsupported_fixture.
  copyFileSync(
    join(localFixturesDir, 'fp-v0-canonical-pass.json'),
    join(mptFixtureDir, 'fp-v0-canonical-pass.json'),
  );
  process.env.PAXIOM_LOCAL_VERIFIER_DATA_DIR = dataDir;
  process.env.PAXIOM_LOCAL_VERIFIER_MPT_FIXTURE_DIR = mptFixtureDir;
  const app = createApp({ dataDir });
  server = await listen(app);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(mptFixtureDir, { recursive: true, force: true });
  delete process.env.PAXIOM_LOCAL_VERIFIER_DATA_DIR;
  delete process.env.PAXIOM_LOCAL_VERIFIER_MPT_FIXTURE_DIR;
});

test('GET /verifiers includes all five foundational verifiers', async () => {
  const resp = await fetch(`${baseUrl}/verifiers`);
  assert.equal(resp.status, 200);
  const ids = (await resp.json()).verifiers.map((v) => v.id);
  for (const expected of [
    'demo-verifier-v0',
    'signature-verifier-v0',
    'fixture-proof-verifier-v0',
    'ethereum-header-fixture-verifier-v0',
    'ethereum-mpt-fixture-verifier-v0',
  ]) {
    assert.ok(ids.includes(expected), `missing ${expected}`);
  }
  assert.ok(listVerifiers().length >= 5);
});

test('valid account proof passes against the fixture state_root', async () => {
  const resp = await postVerify({
    verifier: 'ethereum-mpt-fixture-verifier-v0',
    fixture_id: 'account_19000000_weth',
    proof_type: 'account',
    claimed_state_root: block.state_root,
    claimed_account_address: account.address,
  });
  assert.equal(resp.status, 200);
  const body = await resp.json();
  const r = body.receipt;
  assert.equal(r.decision, 'pass');
  assert.equal(r.reason, 'mpt_account_proof_valid');
  assert.equal(r.verifier_name, 'ethereum-mpt-fixture-verifier-v0');
  assert.equal(r.verifier_version, '0.1.0');
  assert.equal(body.details.proof_node_count, account.account_proof.length);
  assert.equal(body.details.fixture_storage_root, account.storage_root.toLowerCase());
});

test('account proof: wrong claimed_state_root -> fail/state_root_mismatch', async () => {
  const resp = await postVerify({
    verifier: 'ethereum-mpt-fixture-verifier-v0',
    fixture_id: 'account_19000000_weth',
    proof_type: 'account',
    claimed_state_root: '0x' + 'ff'.repeat(32),
    claimed_account_address: account.address,
  });
  assert.equal(resp.status, 422);
  const body = await resp.json();
  assert.equal(body.receipt.decision, 'fail');
  assert.equal(body.receipt.reason, 'state_root_mismatch');
});

test('account proof: wrong claimed_account_address -> fail/mpt_proof_invalid', async () => {
  const resp = await postVerify({
    verifier: 'ethereum-mpt-fixture-verifier-v0',
    fixture_id: 'account_19000000_weth',
    proof_type: 'account',
    claimed_state_root: block.state_root,
    claimed_account_address: '0x' + '0'.repeat(40),
  });
  assert.equal(resp.status, 422);
  const body = await resp.json();
  assert.equal(body.receipt.decision, 'fail');
  assert.equal(body.receipt.reason, 'mpt_proof_invalid');
});

test('account proof: malformed claimed_state_root -> fail/malformed_input', async () => {
  const resp = await postVerify({
    verifier: 'ethereum-mpt-fixture-verifier-v0',
    fixture_id: 'account_19000000_weth',
    proof_type: 'account',
    claimed_state_root: 'not-hex',
    claimed_account_address: account.address,
  });
  assert.equal(resp.status, 422);
  assert.equal((await resp.json()).receipt.reason, 'malformed_input');
});

test('valid storage proof passes against the fixture storage_root', async () => {
  const resp = await postVerify({
    verifier: 'ethereum-mpt-fixture-verifier-v0',
    fixture_id: 'storage_19000000_weth_slot0',
    proof_type: 'storage',
    claimed_storage_root: account.storage_root,
    claimed_account_address: storage.address,
    claimed_storage_slot: storage.slot,
    claimed_storage_value: storage.value,
  });
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(body.receipt.decision, 'pass');
  assert.equal(body.receipt.reason, 'mpt_storage_proof_valid');
  assert.equal(body.details.proof_node_count, storage.storage_proof.length);
});

test('storage proof: wrong claimed_storage_slot -> fail (proof key does not match -> mpt_proof_invalid)', async () => {
  // The fixture's slot is "0x0". Caller claims a different slot. The verifier
  // pre-checks fixture.slot vs claimed_storage_slot and returns mpt_proof_invalid
  // before walking; the proof would in any case not chain at the wrong key.
  const resp = await postVerify({
    verifier: 'ethereum-mpt-fixture-verifier-v0',
    fixture_id: 'storage_19000000_weth_slot0',
    proof_type: 'storage',
    claimed_storage_root: account.storage_root,
    claimed_account_address: storage.address,
    claimed_storage_slot: '0x9',
    claimed_storage_value: storage.value,
  });
  assert.equal(resp.status, 422);
  assert.equal((await resp.json()).receipt.reason, 'mpt_proof_invalid');
});

test('storage proof: wrong claimed_storage_value -> fail/mpt_proof_invalid', async () => {
  const resp = await postVerify({
    verifier: 'ethereum-mpt-fixture-verifier-v0',
    fixture_id: 'storage_19000000_weth_slot0',
    proof_type: 'storage',
    claimed_storage_root: account.storage_root,
    claimed_account_address: storage.address,
    claimed_storage_slot: storage.slot,
    claimed_storage_value: '0x' + 'aa'.repeat(32),
  });
  assert.equal(resp.status, 422);
  assert.equal((await resp.json()).receipt.reason, 'mpt_proof_invalid');
});

test('storage proof: wrong claimed_storage_root -> fail/state_root_mismatch', async () => {
  const resp = await postVerify({
    verifier: 'ethereum-mpt-fixture-verifier-v0',
    fixture_id: 'storage_19000000_weth_slot0',
    proof_type: 'storage',
    claimed_storage_root: '0x' + 'ff'.repeat(32),
    claimed_account_address: storage.address,
    claimed_storage_slot: storage.slot,
    claimed_storage_value: storage.value,
  });
  assert.equal(resp.status, 422);
  assert.equal((await resp.json()).receipt.reason, 'state_root_mismatch');
});

test('storage proof: malformed claimed_storage_value -> fail/malformed_input', async () => {
  const resp = await postVerify({
    verifier: 'ethereum-mpt-fixture-verifier-v0',
    fixture_id: 'storage_19000000_weth_slot0',
    proof_type: 'storage',
    claimed_storage_root: account.storage_root,
    claimed_account_address: storage.address,
    claimed_storage_slot: storage.slot,
    claimed_storage_value: 'definitely-not-hex',
  });
  assert.equal(resp.status, 422);
  assert.equal((await resp.json()).receipt.reason, 'malformed_input');
});

test('missing fixture -> fail/fixture_not_found', async () => {
  const resp = await postVerify({
    verifier: 'ethereum-mpt-fixture-verifier-v0',
    fixture_id: 'no-such-mpt-fixture',
    proof_type: 'account',
    claimed_state_root: block.state_root,
    claimed_account_address: account.address,
  });
  assert.equal(resp.status, 422);
  assert.equal((await resp.json()).receipt.reason, 'fixture_not_found');
});

test('unsupported fixture (canonical-json fixture used as account proof) -> fail/unsupported_fixture', async () => {
  // fp-v0-canonical-pass.json was copied into the MPT fixture dir; it doesn't
  // have address/balance/nonce/account_proof fields.
  const resp = await postVerify({
    verifier: 'ethereum-mpt-fixture-verifier-v0',
    fixture_id: 'fp-v0-canonical-pass',
    proof_type: 'account',
    claimed_state_root: block.state_root,
    claimed_account_address: account.address,
  });
  assert.equal(resp.status, 422);
  assert.equal((await resp.json()).receipt.reason, 'unsupported_fixture');
});

test('malformed input: invalid proof_type -> fail/malformed_input', async () => {
  const resp = await postVerify({
    verifier: 'ethereum-mpt-fixture-verifier-v0',
    fixture_id: 'account_19000000_weth',
    proof_type: 'something-else',
    claimed_state_root: block.state_root,
    claimed_account_address: account.address,
  });
  assert.equal(resp.status, 422);
  assert.equal((await resp.json()).receipt.reason, 'malformed_input');
});

test('malformed input: path-traversal fixture_id -> fail/malformed_input', async () => {
  const resp = await postVerify({
    verifier: 'ethereum-mpt-fixture-verifier-v0',
    fixture_id: '../package',
    proof_type: 'account',
    claimed_state_root: block.state_root,
    claimed_account_address: account.address,
  });
  assert.equal(resp.status, 422);
  assert.equal((await resp.json()).receipt.reason, 'malformed_input');
});

test('receipt is stored and retrievable via GET /receipts/:id', async () => {
  const verifyResp = await postVerify({
    verifier: 'ethereum-mpt-fixture-verifier-v0',
    fixture_id: 'account_19000000_weth',
    proof_type: 'account',
    claimed_state_root: block.state_root,
    claimed_account_address: account.address,
  });
  const { receipt } = await verifyResp.json();
  const fetched = await fetch(`${baseUrl}/receipts/${receipt.receipt_id}`);
  assert.equal(fetched.status, 200);
  assert.deepEqual(await fetched.json(), receipt);
});

test('replay (HTTP + CLI) confirms hash and signature for an MPT receipt', async () => {
  const verifyResp = await postVerify({
    verifier: 'ethereum-mpt-fixture-verifier-v0',
    fixture_id: 'storage_19000000_weth_slot0',
    proof_type: 'storage',
    claimed_storage_root: account.storage_root,
    claimed_account_address: storage.address,
    claimed_storage_slot: storage.slot,
    claimed_storage_value: storage.value,
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

test('regression: demo-verifier-v0 still passes', async () => {
  const message = 'mpt-suite-demo';
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
    verifier: 'signature-verifier-v0', payload, public_key_pem: publicKeyPem, signature, algorithm: 'ed25519',
  });
  assert.equal(resp.status, 200);
  assert.equal((await resp.json()).receipt.reason, 'signature_valid');
});

test('regression: fixture-proof-verifier-v0 still passes', async () => {
  // The local-verifier fixture dir is the default for fixture-proof-verifier-v0;
  // PAXIOM_LOCAL_VERIFIER_MPT_FIXTURE_DIR only redirects the MPT verifier.
  const resp = await postVerify({
    verifier: 'fixture-proof-verifier-v0',
    fixture_id: 'fp-v0-canonical-pass',
    claimed_result: 'pass',
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

test('five verifier types interleave in one audit chain via prior_receipt_hash', async () => {
  const m = 'five-way-chain';
  const claimed = createHash('sha256').update(m).digest('hex');
  const r1 = await (await postVerify({ verifier: 'demo-verifier-v0', message: m, claimed_sha256: claimed })).json();

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pubPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const payload = { five: 'way' };
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

  const r5 = await (await postVerify({
    verifier: 'ethereum-mpt-fixture-verifier-v0',
    fixture_id: 'account_19000000_weth',
    proof_type: 'account',
    claimed_state_root: block.state_root,
    claimed_account_address: account.address,
  })).json();

  assert.equal(r2.receipt.prior_receipt_hash, r1.receipt.receipt_hash);
  assert.equal(r3.receipt.prior_receipt_hash, r2.receipt.receipt_hash);
  assert.equal(r4.receipt.prior_receipt_hash, r3.receipt.receipt_hash);
  assert.equal(r5.receipt.prior_receipt_hash, r4.receipt.receipt_hash);
  assert.equal(r5.receipt.verifier_name, 'ethereum-mpt-fixture-verifier-v0');
});
