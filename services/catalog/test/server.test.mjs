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

test('catalog exposes the five public Phase 1 services', async () => {
  const { server, url } = await listen(createApp());
  try {
    const resp = await fetch(`${url}/.well-known/paxiom-services.json`);
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.deepEqual(body.services.map((s) => s.id), ['A-201', 'A-202', 'A-203', 'A-204', 'A-205']);
    assert.equal(body.services.find((s) => s.id === 'A-204').price.amount, '0.05');
  } finally {
    server.close();
  }
});
