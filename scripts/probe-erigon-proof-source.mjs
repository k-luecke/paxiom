#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ErigonProofClient } from '../load-network/erigon-client.mjs';
import { reconstructStorageSlot } from '../load-network/reconstruct.mjs';

loadLocalErigonEnv();

const rpcUrl = process.env.PAXIOM_ERIGON_RPC_URL || process.env.LOAD_NETWORK_URL || 'http://127.0.0.1:8545';
const blockNumber = Number(process.env.PAXIOM_ERIGON_PROOF_BLOCK || process.env.LIVE_BLOCK || 19_000_000);
const address = (process.env.PAXIOM_ERIGON_PROOF_ADDRESS || process.env.LIVE_ADDRESS || '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2').toLowerCase();
const slot = process.env.PAXIOM_ERIGON_PROOF_SLOT || '0x0';
const required = process.env.PAXIOM_ERIGON_PROOF_REQUIRED === '1';

try {
  const syncing = await rpc('eth_syncing', []);
  const headHex = await rpc('eth_blockNumber', []);
  const head = hexQuantityToNumber(headHex);
  if (head < blockNumber) {
    returnNotReady({
      reason: 'erigon_head_behind_requested_block',
      rpcUrl,
      requestedBlock: blockNumber,
      currentHead: head,
      syncing,
    });
  }

  const client = new ErigonProofClient({ rpcUrl });
  const result = await reconstructStorageSlot({ blockNumber, address, slot, client });
  const summary = {
    status: 'verified',
    source: result.source,
    rpcUrl,
    block_number: result.block_number,
    block_hash: result.block_hash,
    state_root: result.state_root,
    address: result.address,
    slot: result.slot,
    value: result.value,
    witness: {
      account_proof_nodes: result.witness.account_proof.length,
      storage_proof_nodes: result.witness.storage_proof.length,
      account_key: result.witness.account_key,
      storage_key: result.witness.storage_key,
    },
  };
  console.log(JSON.stringify(summary, null, 2));
} catch (e) {
  returnNotReady({
    reason: 'proof_source_unavailable_or_unverified',
    rpcUrl,
    requestedBlock: blockNumber,
    error: e.name || 'Error',
    detail: e.message,
    category: e.category,
    verificationReason: e.reason,
  });
}

async function rpc(method, params) {
  const resp = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!resp.ok) throw new Error(`Erigon RPC HTTP ${resp.status} for ${method}`);
  const body = await resp.json();
  if (body.error) throw new Error(`Erigon RPC error for ${method}: ${body.error.message || body.error.code}`);
  return body.result;
}

function returnNotReady(payload) {
  const body = {
    status: 'not_ready',
    note: 'Local or VM-hosted Erigon is not yet able to produce and verify this proof. This is expected during initial archive sync.',
    ...payload,
  };
  console.log(JSON.stringify(body, null, 2));
  process.exit(required ? 1 : 0);
}

function hexQuantityToNumber(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) return 0;
  const parsed = Number.parseInt(value, 16);
  return Number.isFinite(parsed) ? parsed : 0;
}

function loadLocalErigonEnv() {
  const envFile = resolve('.paxiom', 'erigon.env');
  if (!existsSync(envFile)) return;
  const lines = readFileSync(envFile, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^export\s+([A-Z0-9_]+)=(?:"([^"]*)"|'([^']*)'|(.+))$/);
    if (!match) continue;
    const [, key, doubleQuoted, singleQuoted, raw] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = doubleQuoted ?? singleQuoted ?? raw.trim();
  }
}
