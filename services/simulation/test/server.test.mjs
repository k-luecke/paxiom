import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

test('A-204 returns a deterministic simulation receipt', async () => {
  const { server, url } = await listen(createApp());
  try {
    const resp = await fetch(`${url}/v1/simulations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chain: 'base',
        to: '0x0000000000000000000000000000000000000001',
        data: '0x1234',
      }),
    });
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.service, 'A-204');
    assert.equal(body.artifact.type, 'simulation_receipt');
    assert.equal(body.artifact.payload.success, true);
    assert.equal(body.artifact.payload.gas_used, 21032);
  } finally {
    server.close();
  }
});

test('A-204 rejects malformed simulation requests', async () => {
  const { server, url } = await listen(createApp());
  try {
    const resp = await fetch(`${url}/v1/simulations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chain: 'base', to: 'not-an-address' }),
    });
    assert.equal(resp.status, 400);
  } finally {
    server.close();
  }
});
