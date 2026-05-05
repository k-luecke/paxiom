import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from '../server.mjs';

process.env.MOCK_LOAD_NETWORK = '1';

function listen(app) {
  return new Promise((resolveListen) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolveListen({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

const manifest = JSON.parse(readFileSync(resolve('load-network/fixtures/MANIFEST.json'), 'utf8'));

test('load-network service reconstructs a verified storage slot', async () => {
  const { server, url } = await listen(createApp());
  try {
    const resp = await fetch(`${url}/v1/load-network/reconstruct/storage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        blockNumber: manifest.block_number,
        address: manifest.anchor_address,
        slot: manifest.anchor_slot,
      }),
    });
    assert.equal(resp.status, 200);
    assert.ok(resp.headers.get('payment-response'));
    const body = await resp.json();
    assert.equal(body.verified, true);
    assert.equal(body.source, 'load.network');
    assert.equal(body.slot, manifest.anchor_slot);
    assert.ok(Array.isArray(body.witness.storage_proof));
  } finally {
    server.close();
  }
});

test('load-network service returns x402 payment requirement when enabled', async () => {
  const oldRequire = process.env.REQUIRE_X402;
  const oldFacilitator = process.env.X402_FACILITATOR_URL;
  process.env.REQUIRE_X402 = '1';
  process.env.X402_FACILITATOR_URL = 'http://x402-test-stub.invalid';
  const { server, url } = await listen(createApp());
  try {
    const resp = await fetch(`${url}/v1/load-network/reconstruct/account`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        blockNumber: manifest.block_number,
        address: manifest.anchor_address,
      }),
    });
    assert.equal(resp.status, 402);
    assert.ok(resp.headers.get('payment-required'));
  } finally {
    process.env.REQUIRE_X402 = oldRequire;
    process.env.X402_FACILITATOR_URL = oldFacilitator;
    server.close();
  }
});
