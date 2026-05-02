// Fixture-driven test for the load.network state reconstruction pipeline.
//
// Substitutes a fixture-backed `fetchImpl` for the real network so this is
// the CI gate. The live test (`live.test.mjs`) hits real load.network and
// runs only when `LOAD_NETWORK_LIVE=1` is set.
//
// Acceptance: end-to-end reconstruction for the anchor block in
// fixtures/MANIFEST.json returns the canonical state-root and the expected
// account/slot fields. This is what the A-120 / S.03 gate is asking for.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { LoadNetworkClient } from '../client.mjs';
import { reconstructAccountState, reconstructStorageSlot } from '../reconstruct.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(here, '..', 'fixtures');

function loadFixture(name) {
  return JSON.parse(readFileSync(resolve(fixturesDir, name), 'utf8'));
}

const manifest = loadFixture('MANIFEST.json');
const blockFile = `block_${manifest.block_number}.json`;
const accountFile = `account_${manifest.block_number}_weth.json`;
const slotFile = `storage_${manifest.block_number}_weth_slot0.json`;

// fixtureFetch maps the load.network paths reconstruct.mjs hits onto the
// recorded fixture files.
function fixtureFetch(url) {
  const u = new URL(url);
  const path = u.pathname;
  const matchAccount = path.match(/^\/v1\/state\/(\d+)\/account\/(0x[0-9a-fA-F]+)$/);
  const matchSlot = path.match(/^\/v1\/state\/(\d+)\/storage\/(0x[0-9a-fA-F]+)\/(\S+)$/);
  const matchBlock = path.match(/^\/v1\/blocks\/(\d+)$/);

  if (matchBlock) {
    return Promise.resolve(jsonResponse(loadFixture(blockFile)));
  }
  if (matchAccount) {
    return Promise.resolve(jsonResponse(loadFixture(accountFile)));
  }
  if (matchSlot) {
    return Promise.resolve(jsonResponse(loadFixture(slotFile)));
  }
  return Promise.resolve(notFoundResponse(`fixture has no entry for ${path}`));
}

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    headers: new Map(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function notFoundResponse(detail) {
  return {
    ok: false,
    status: 404,
    headers: new Map(),
    json: async () => ({ error: detail }),
    text: async () => detail,
  };
}

test('reconstructAccountState returns canonical state root + account fields from fixture', async () => {
  const client = new LoadNetworkClient({ fetchImpl: fixtureFetch });
  const result = await reconstructAccountState({
    blockNumber: manifest.block_number,
    address: manifest.anchor_address,
    client,
  });

  assert.equal(result.block_number, manifest.block_number);
  assert.equal(result.address.toLowerCase(), manifest.anchor_address.toLowerCase());
  assert.match(result.state_root, /^0x[0-9a-f]{64}$/);
  assert.match(result.block_hash, /^0x[0-9a-f]{64}$/);
  assert.equal(result.source, 'load.network');
  assert.ok(result.archive_root);
});

test('reconstructStorageSlot returns slot value rooted in the archive', async () => {
  const client = new LoadNetworkClient({ fetchImpl: fixtureFetch });
  const result = await reconstructStorageSlot({
    blockNumber: manifest.block_number,
    address: manifest.anchor_address,
    slot: manifest.anchor_slot,
    client,
  });

  assert.equal(result.block_number, manifest.block_number);
  assert.equal(result.slot, manifest.anchor_slot);
  assert.match(result.value, /^0x[0-9a-f]+$/);
  assert.equal(result.source, 'load.network');
});

test('reconstructAccountState rejects address mismatch', async () => {
  const wrongAccountFetch = (url) => {
    if (url.endsWith('/v1/blocks/19000000')) {
      return Promise.resolve(jsonResponse(loadFixture(blockFile)));
    }
    if (url.includes('/account/')) {
      const original = loadFixture(accountFile);
      return Promise.resolve(jsonResponse({
        ...original,
        address: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      }));
    }
    return Promise.resolve(notFoundResponse('unexpected'));
  };
  const client = new LoadNetworkClient({ fetchImpl: wrongAccountFetch });
  await assert.rejects(
    () => reconstructAccountState({
      blockNumber: manifest.block_number,
      address: manifest.anchor_address,
      client,
    }),
    /address mismatch/,
  );
});
