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

test('A-205 returns verified historical storage state', async () => {
  const { server, url } = await listen(createApp());
  try {
    const resp = await fetch(`${url}/v1/historical-state/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        blockNumber: manifest.block_number,
        address: manifest.anchor_address,
        slot: manifest.anchor_slot,
      }),
    });
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.service, 'A-205');
    assert.equal(body.artifact.type, 'verified_historical_storage_state');
    assert.equal(body.artifact.payload.verified, true);
    assert.match(body.platformSignature.signature, /^dev:/);
  } finally {
    server.close();
  }
});
