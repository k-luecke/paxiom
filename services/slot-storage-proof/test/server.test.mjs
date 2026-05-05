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

test('A-201 returns a signed slot storage proof packet', async () => {
  const { server, url } = await listen(createApp());
  try {
    const resp = await fetch(`${url}/v1/slot-storage-proofs`, {
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
    assert.equal(body.service, 'A-201');
    assert.equal(body.artifact.type, 'slot_storage_proof_packet');
    assert.equal(body.artifact.payload.verified, true);
    assert.equal(body.auditRecord.target, 'AO/Arweave');
    assert.match(body.platformSignature.responseHash, /^0x[0-9a-f]{64}$/);
  } finally {
    server.close();
  }
});
