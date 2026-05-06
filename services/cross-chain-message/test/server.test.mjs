import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupResponseSigningKey } from '../../shared/test/sign-test-helper.mjs';
import { createApp } from '../server.mjs';

setupResponseSigningKey();

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

test('A-203 returns a cross-chain message evidence attestation packet', async () => {
  const { server, url } = await listen(createApp());
  try {
    const resp = await fetch(`${url}/v1/cross-chain-messages/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceChain: 'optimism',
        targetChain: 'base',
        messageId: 'msg-1',
        originTxHash: '0x' + 'a'.repeat(64),
      }),
    });
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.service, 'A-203');
    assert.equal(body.artifact.type, 'cross_chain_message_evidence_request');
    assert.equal(body.artifact.payload.status, 'reference_evidence_packet');
    assert.equal(body.artifact.payload.verified, false);
  } finally {
    server.close();
  }
});
