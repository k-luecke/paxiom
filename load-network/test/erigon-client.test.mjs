import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ErigonProofClient } from '../erigon-client.mjs';
import { LoadNetworkProtocolError } from '../errors.mjs';

const ADDRESS = '0xC02aaA39b223FE8D0A0E5C4F27eAD9083C756Cc2';
const BLOCK_HASH = `0x${'11'.repeat(32)}`;
const STATE_ROOT = `0x${'22'.repeat(32)}`;
const STORAGE_ROOT = `0x${'33'.repeat(32)}`;
const CODE_HASH = `0x${'44'.repeat(32)}`;

test('ErigonProofClient maps eth_getBlockByNumber into archive block shape', async () => {
  const calls = [];
  const client = new ErigonProofClient({ fetchImpl: rpcFetch(calls) });

  const block = await client.getArchivedBlock(19_000_000);

  assert.deepEqual(calls[0], {
    method: 'eth_getBlockByNumber',
    params: ['0x121eac0', false],
  });
  assert.equal(block.block_number, 19_000_000);
  assert.equal(block.block_hash, BLOCK_HASH);
  assert.equal(block.state_root, STATE_ROOT);
  assert.equal(block.archive_root, `erigon:${BLOCK_HASH}`);
  assert.equal(block.source, 'local-erigon');
});

test('ErigonProofClient maps eth_getProof account and storage entries into verified-source shape', async () => {
  const calls = [];
  const client = new ErigonProofClient({ fetchImpl: rpcFetch(calls) });

  const account = await client.getAccountProof('19000000', ADDRESS);
  const storage = await client.getStorageProof('0x121eac0', ADDRESS, '0x0');

  assert.equal(account.address, ADDRESS.toLowerCase());
  assert.equal(account.balance, '0x0');
  assert.equal(account.nonce, '0x1');
  assert.equal(account.code_hash, CODE_HASH);
  assert.equal(account.storage_root, STORAGE_ROOT);
  assert.deepEqual(account.account_proof, ['0xf801']);
  assert.equal(account.source, 'local-erigon');

  assert.equal(storage.address, ADDRESS.toLowerCase());
  assert.equal(storage.slot, '0x0');
  assert.equal(storage.value, '0x00');
  assert.deepEqual(storage.storage_proof, ['0xf802']);
  assert.equal(storage.source, 'local-erigon');

  assert.deepEqual(calls.map((c) => c.method), [
    'eth_getProof',
    'eth_getProof',
  ]);
  assert.deepEqual(calls[1].params, [ADDRESS.toLowerCase(), ['0x0'], '0x121eac0']);
});

test('ErigonProofClient fails closed on malformed proof shape', async () => {
  const client = new ErigonProofClient({
    fetchImpl: async () => jsonResponse({
      jsonrpc: '2.0',
      id: 1,
      result: {
        address: ADDRESS,
        balance: '0x0',
        nonce: '0x1',
        codeHash: CODE_HASH,
        storageHash: STORAGE_ROOT,
      },
    }),
  });

  await assert.rejects(
    () => client.getAccountProof(19_000_000, ADDRESS),
    (e) => e instanceof LoadNetworkProtocolError && e.field === 'accountProof',
  );
});

function rpcFetch(calls) {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ method: body.method, params: body.params });
    if (body.method === 'eth_getBlockByNumber') {
      return jsonResponse({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          number: '0x121eac0',
          hash: BLOCK_HASH,
          stateRoot: STATE_ROOT,
        },
      });
    }
    if (body.method === 'eth_getProof' && body.params[1].length === 0) {
      return jsonResponse({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          address: ADDRESS,
          balance: '0x0',
          nonce: '0x1',
          codeHash: CODE_HASH,
          storageHash: STORAGE_ROOT,
          accountProof: ['0xf801'],
          storageProof: [],
        },
      });
    }
    if (body.method === 'eth_getProof' && body.params[1].length === 1) {
      return jsonResponse({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          address: ADDRESS,
          balance: '0x0',
          nonce: '0x1',
          codeHash: CODE_HASH,
          storageHash: STORAGE_ROOT,
          accountProof: ['0xf801'],
          storageProof: [{
            key: body.params[1][0],
            value: '0x0',
            proof: ['0xf802'],
          }],
        },
      });
    }
    throw new Error(`unexpected RPC call ${body.method}`);
  };
}

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}
