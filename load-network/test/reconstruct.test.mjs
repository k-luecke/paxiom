// Fixture-driven test for the load.network state reconstruction pipeline.
//
// The fixture is synthesised via load-network/fixtures/synthesise.mjs and
// includes valid MPT proofs against synthetic state and storage roots.
// Every assertion below exercises the real verifier walk — there is no
// stub-out. This is the CI gate for the no-RPC architectural moat.
//
// Acceptance: end-to-end reconstruction returns a verified envelope
// whose `witness` field carries the MPT path Service 01's ZK circuit
// expects, and any tampered input surfaces as a LoadNetworkVerificationError
// with a stable `reason` — no silent fallback.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { LoadNetworkClient } from '../client.mjs';
import { reconstructAccountState, reconstructStorageSlot } from '../reconstruct.mjs';
import {
  LoadNetworkVerificationError,
  LoadNetworkDataError,
  LoadNetworkProtocolError,
  VerificationReasons,
} from '../errors.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(here, '..', 'fixtures');

function loadFixture(name) {
  return JSON.parse(readFileSync(resolve(fixturesDir, name), 'utf8'));
}

const manifest = loadFixture('MANIFEST.json');
const blockFile   = `block_${manifest.block_number}.json`;
const accountFile = `account_${manifest.block_number}_weth.json`;
const slotFile    = `storage_${manifest.block_number}_weth_slot0.json`;

// fixtureFetch maps load.network URLs onto recorded fixture JSON.
function fixtureFetch(overrides = {}) {
  return (url) => {
    const u = new URL(url);
    const path = u.pathname;

    if (overrides[path]) return Promise.resolve(jsonResponse(overrides[path]));
    if (overrides.__fail?.[path]) return Promise.resolve(overrides.__fail[path]);

    if (path.match(/^\/v1\/blocks\/(\d+)$/)) {
      return Promise.resolve(jsonResponse(loadFixture(blockFile)));
    }
    if (path.match(/^\/v1\/state\/(\d+)\/account\/(0x[0-9a-fA-F]+)$/)) {
      return Promise.resolve(jsonResponse(loadFixture(accountFile)));
    }
    if (path.match(/^\/v1\/state\/(\d+)\/storage\/(0x[0-9a-fA-F]+)\/(\S+)$/)) {
      return Promise.resolve(jsonResponse(loadFixture(slotFile)));
    }
    return Promise.resolve(notFoundResponse(`fixture has no entry for ${path}`));
  };
}

function jsonResponse(body) {
  return {
    ok: true, status: 200, headers: new Map(),
    json: async () => body, text: async () => JSON.stringify(body),
  };
}

function notFoundResponse(detail) {
  return {
    ok: false, status: 404, headers: new Map(),
    json: async () => ({ error: detail }), text: async () => detail,
  };
}

// ─── Happy path: reconstructAccountState ────────────────────────────────

test('reconstructAccountState verifies the account proof and exposes ZK witness', async () => {
  const client = new LoadNetworkClient({ fetchImpl: fixtureFetch() });
  const r = await reconstructAccountState({
    blockNumber: manifest.block_number,
    address: manifest.anchor_address,
    client,
  });

  assert.equal(r.verified, true);
  assert.equal(r.block_number, manifest.block_number);
  assert.equal(r.address.toLowerCase(), manifest.anchor_address.toLowerCase());
  assert.match(r.state_root, /^0x[0-9a-f]{64}$/);
  assert.match(r.block_hash, /^0x[0-9a-f]{64}$/);
  assert.equal(r.source, 'load.network');
  assert.ok(r.archive_root);

  // Witness is what Service 01's ZK circuit consumes
  assert.match(r.witness.account_key, /^0x[0-9a-f]{64}$/);
  assert.equal(r.witness.state_root, r.state_root);
  assert.ok(Array.isArray(r.witness.account_proof));
  assert.ok(r.witness.account_proof.length > 0);
  for (const node of r.witness.account_proof) {
    assert.match(node, /^0x[0-9a-f]+$/);
  }
});

// ─── Happy path: reconstructStorageSlot (composed) ─────────────────────

test('reconstructStorageSlot verifies both proofs and exposes combined witness', async () => {
  const client = new LoadNetworkClient({ fetchImpl: fixtureFetch() });
  const r = await reconstructStorageSlot({
    blockNumber: manifest.block_number,
    address: manifest.anchor_address,
    slot: manifest.anchor_slot,
    client,
  });

  assert.equal(r.verified, true);
  assert.equal(r.slot, manifest.anchor_slot);
  assert.match(r.value, /^0x[0-9a-f]+$/);
  assert.equal(r.source, 'load.network');

  // Combined witness binds slot value → storage root → account → state root
  assert.equal(r.witness.state_root, r.state_root);
  assert.equal(r.witness.storage_root, r.storage_root);
  assert.match(r.witness.account_key, /^0x[0-9a-f]{64}$/);
  assert.match(r.witness.storage_key, /^0x[0-9a-f]{64}$/);
  assert.ok(Array.isArray(r.witness.account_proof));
  assert.ok(Array.isArray(r.witness.storage_proof));
});

// ─── Verification failure paths — these are the no-RPC moat ─────────────

test('reconstructStorageSlot rejects tampered storage value (no fallback)', async () => {
  const slot = loadFixture(slotFile);
  const tampered = { ...slot, value: '0x' + 'ee'.repeat(32) };
  const client = new LoadNetworkClient({
    fetchImpl: fixtureFetch({ [`/v1/state/${manifest.block_number}/storage/${manifest.anchor_address}/${manifest.anchor_slot}`]: tampered }),
  });

  await assert.rejects(
    () => reconstructStorageSlot({
      blockNumber: manifest.block_number,
      address: manifest.anchor_address,
      slot: manifest.anchor_slot,
      client,
    }),
    (e) => e instanceof LoadNetworkVerificationError
        && e.reason === VerificationReasons.STORAGE_VALUE_MISMATCH,
  );
});

test('reconstructAccountState rejects tampered state_root (no fallback)', async () => {
  const block = loadFixture(blockFile);
  const tampered = { ...block, state_root: '0x' + 'ff'.repeat(32) };
  const client = new LoadNetworkClient({
    fetchImpl: fixtureFetch({ [`/v1/blocks/${manifest.block_number}`]: tampered }),
  });

  await assert.rejects(
    () => reconstructAccountState({
      blockNumber: manifest.block_number,
      address: manifest.anchor_address,
      client,
    }),
    (e) => e instanceof LoadNetworkVerificationError
        && e.reason === VerificationReasons.PROOF_ROOT_MISMATCH,
  );
});

test('reconstructAccountState rejects empty proof array', async () => {
  const account = loadFixture(accountFile);
  const tampered = { ...account, account_proof: [] };
  const client = new LoadNetworkClient({
    fetchImpl: fixtureFetch({ [`/v1/state/${manifest.block_number}/account/${manifest.anchor_address}`]: tampered }),
  });

  await assert.rejects(
    () => reconstructAccountState({
      blockNumber: manifest.block_number,
      address: manifest.anchor_address,
      client,
    }),
    (e) => e instanceof LoadNetworkVerificationError
        && e.reason === VerificationReasons.EMPTY_PROOF,
  );
});

// ─── Shape-drift paths — surface as ProtocolError, not retried ──────────

test('reconstructAccountState raises ProtocolError on missing field', async () => {
  const account = loadFixture(accountFile);
  const broken = { ...account };
  delete broken.account_proof;
  const client = new LoadNetworkClient({
    fetchImpl: fixtureFetch({ [`/v1/state/${manifest.block_number}/account/${manifest.anchor_address}`]: broken }),
  });

  await assert.rejects(
    () => reconstructAccountState({
      blockNumber: manifest.block_number,
      address: manifest.anchor_address,
      client,
    }),
    (e) => e instanceof LoadNetworkProtocolError && e.field === 'account_proof',
  );
});

test('reconstructAccountState raises DataError on address mismatch', async () => {
  const account = loadFixture(accountFile);
  const wrong = { ...account, address: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' };
  const client = new LoadNetworkClient({
    fetchImpl: fixtureFetch({ [`/v1/state/${manifest.block_number}/account/${manifest.anchor_address}`]: wrong }),
  });

  await assert.rejects(
    () => reconstructAccountState({
      blockNumber: manifest.block_number,
      address: manifest.anchor_address,
      client,
    }),
    (e) => e instanceof LoadNetworkDataError,
  );
});
