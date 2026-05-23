// Local Erigon proof client.
//
// This is the bridge from the temporary Load-shaped proof interface to
// Paxiom's own local execution warehouse. It reads EIP-1186 proofs from a
// local Erigon JSON-RPC endpoint, then returns the same minimal shape that
// reconstruct.mjs already verifies cryptographically. The JSON-RPC server
// is not the trust anchor; the MPT verifier is.

import {
  LoadNetworkDataError,
  LoadNetworkNetworkError,
  LoadNetworkProtocolError,
} from './errors.mjs';

const DEFAULT_RPC_URL = 'http://127.0.0.1:8545';
const DEFAULT_TIMEOUT_MS = 30_000;

export class ErigonProofClient {
  constructor({
    rpcUrl = process.env.PAXIOM_ERIGON_RPC_URL || process.env.LOAD_NETWORK_URL || DEFAULT_RPC_URL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
    onEvent,
  } = {}) {
    this.rpcUrl = rpcUrl;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
    this.onEvent = onEvent ?? (() => {});
    this.source = 'local-erigon';
  }

  async getArchivedBlock(blockNumber) {
    const blockTag = blockTagHex(blockNumber);
    const block = await this.#rpc('eth_getBlockByNumber', [blockTag, false], { stage: 'eth_getBlockByNumber' });
    ensureFields(block, ['number', 'hash', 'stateRoot'], 'eth_getBlockByNumber');
    return {
      block_number: Number.parseInt(block.number, 16),
      block_hash: block.hash,
      state_root: block.stateRoot,
      archive_root: `erigon:${block.hash}`,
      source: this.source,
    };
  }

  async getAccountProof(blockNumber, address) {
    const blockTag = blockTagHex(blockNumber);
    const normalizedAddress = normalizeAddress(address);
    const proof = await this.#rpc(
      'eth_getProof',
      [normalizedAddress, [], blockTag],
      { stage: 'eth_getProof.account' },
    );
    ensureFields(proof, ['address', 'balance', 'nonce', 'codeHash', 'storageHash', 'accountProof'], 'eth_getProof.account');
    if (!Array.isArray(proof.accountProof)) {
      throw new LoadNetworkProtocolError('eth_getProof.account: accountProof must be an array', {
        field: 'accountProof',
        stage: 'eth_getProof.account',
      });
    }
    return {
      block_number: Number.parseInt(blockTag, 16),
      address: normalizeAddress(proof.address),
      balance: normalizeQuantity(proof.balance, 'balance'),
      nonce: normalizeQuantity(proof.nonce, 'nonce'),
      code_hash: normalizeBytesHex(proof.codeHash, 'codeHash'),
      storage_root: normalizeBytesHex(proof.storageHash, 'storageHash'),
      account_proof: proof.accountProof.map((node, i) => normalizeBytesHex(node, `accountProof[${i}]`)),
      source: this.source,
    };
  }

  async getStorageProof(blockNumber, address, slot) {
    const blockTag = blockTagHex(blockNumber);
    const normalizedAddress = normalizeAddress(address);
    const slotForRpc = slotHex(slot);
    const proof = await this.#rpc(
      'eth_getProof',
      [normalizedAddress, [slotForRpc], blockTag],
      { stage: 'eth_getProof.storage' },
    );
    ensureFields(proof, ['address', 'storageProof'], 'eth_getProof.storage');
    if (!Array.isArray(proof.storageProof) || proof.storageProof.length !== 1) {
      throw new LoadNetworkProtocolError('eth_getProof.storage: expected exactly one storageProof entry', {
        field: 'storageProof',
        stage: 'eth_getProof.storage',
      });
    }
    const entry = proof.storageProof[0];
    ensureFields(entry, ['value', 'proof'], 'eth_getProof.storage[0]');
    if (!Array.isArray(entry.proof)) {
      throw new LoadNetworkProtocolError('eth_getProof.storage[0]: proof must be an array', {
        field: 'proof',
        stage: 'eth_getProof.storage[0]',
      });
    }
    return {
      block_number: Number.parseInt(blockTag, 16),
      address: normalizeAddress(proof.address),
      slot: slotForRpc,
      value: normalizeValueHex(entry.value, 'storageProof[0].value'),
      storage_proof: entry.proof.map((node, i) => normalizeBytesHex(node, `storageProof[0].proof[${i}]`)),
      source: this.source,
    };
  }

  async getReconstructedState(blockNumber, address) {
    return this.getAccountProof(blockNumber, address);
  }

  async getStorageSlot(blockNumber, address, slot) {
    return this.getStorageProof(blockNumber, address, slot);
  }

  async #rpc(method, params, ctx) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    const startedAt = Date.now();
    this.onEvent({ ...ctx, method, event: 'request_start', url: this.rpcUrl });

    try {
      const resp = await this.fetch(this.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        signal: ctl.signal,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      if (!resp.ok) {
        throw new LoadNetworkNetworkError(`Erigon RPC HTTP ${resp.status} for ${method}`, {
          status: resp.status,
          body: await safeText(resp),
          stage: ctx.stage,
        });
      }
      let json;
      try {
        json = await resp.json();
      } catch (e) {
        throw new LoadNetworkProtocolError(`Erigon RPC malformed JSON for ${method}: ${e.message}`, {
          stage: ctx.stage,
          cause: e,
        });
      }
      if (json.error) {
        throw new LoadNetworkDataError(`Erigon RPC error for ${method}: ${json.error.message || json.error.code}`, {
          status: json.error.code,
          body: json.error,
          stage: ctx.stage,
        });
      }
      if (json.result === undefined || json.result === null) {
        throw new LoadNetworkDataError(`Erigon RPC empty result for ${method}`, {
          stage: ctx.stage,
        });
      }
      this.onEvent({ ...ctx, method, event: 'request_ok', latencyMs: Date.now() - startedAt });
      return json.result;
    } catch (e) {
      if (e instanceof LoadNetworkDataError || e instanceof LoadNetworkNetworkError || e instanceof LoadNetworkProtocolError) {
        throw e;
      }
      throw new LoadNetworkNetworkError(`Erigon RPC transport failure for ${method}: ${e.message}`, {
        stage: ctx.stage,
        cause: e,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

function ensureFields(obj, fields, where) {
  for (const field of fields) {
    if (obj?.[field] === undefined || obj?.[field] === null) {
      throw new LoadNetworkProtocolError(`${where}: missing required field '${field}'`, {
        field,
        stage: where,
      });
    }
  }
}

function blockTagHex(blockNumber) {
  if (typeof blockNumber === 'number') {
    if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) {
      throw new LoadNetworkDataError(`invalid block number: ${blockNumber}`, { stage: 'blockTagHex' });
    }
    return `0x${blockNumber.toString(16)}`;
  }
  if (typeof blockNumber === 'bigint') {
    if (blockNumber < 0n) throw new LoadNetworkDataError(`invalid block number: ${blockNumber}`, { stage: 'blockTagHex' });
    return `0x${blockNumber.toString(16)}`;
  }
  if (typeof blockNumber === 'string') {
    if (/^0x[0-9a-f]+$/i.test(blockNumber)) return blockNumber.toLowerCase();
    if (/^[0-9]+$/.test(blockNumber)) return `0x${BigInt(blockNumber).toString(16)}`;
  }
  throw new LoadNetworkDataError(`invalid block tag: ${blockNumber}`, { stage: 'blockTagHex' });
}

function normalizeAddress(address) {
  if (typeof address !== 'string' || !/^0x[0-9a-f]{40}$/i.test(address)) {
    throw new LoadNetworkDataError(`invalid address: ${address}`, { stage: 'normalizeAddress' });
  }
  return address.toLowerCase();
}

function slotHex(slot) {
  if (typeof slot === 'number') {
    if (!Number.isSafeInteger(slot) || slot < 0) {
      throw new LoadNetworkDataError(`invalid slot: ${slot}`, { stage: 'slotHex' });
    }
    return `0x${slot.toString(16)}`;
  }
  if (typeof slot === 'bigint') {
    if (slot < 0n) throw new LoadNetworkDataError(`invalid slot: ${slot}`, { stage: 'slotHex' });
    return `0x${slot.toString(16)}`;
  }
  if (typeof slot === 'string') {
    if (/^0x[0-9a-f]*$/i.test(slot)) return slot === '0x' ? '0x0' : slot.toLowerCase();
    if (/^[0-9]+$/.test(slot)) return `0x${BigInt(slot).toString(16)}`;
  }
  throw new LoadNetworkDataError(`invalid slot: ${slot}`, { stage: 'slotHex' });
}

function normalizeQuantity(value, field) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) {
    throw new LoadNetworkProtocolError(`${field}: expected hex quantity`, { field });
  }
  return value.toLowerCase();
}

function normalizeValueHex(value, field) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]*$/i.test(value)) {
    throw new LoadNetworkProtocolError(`${field}: expected hex value`, { field });
  }
  const digits = value.slice(2).toLowerCase();
  if (digits.length === 0) return '0x';
  return `0x${digits.length % 2 === 0 ? digits : `0${digits}`}`;
}

function normalizeBytesHex(value, field) {
  const normalized = normalizeValueHex(value, field);
  if (normalized === '0x') {
    throw new LoadNetworkProtocolError(`${field}: empty hex bytes`, { field });
  }
  return normalized;
}

async function safeText(resp) {
  try { return await resp.text(); } catch { return undefined; }
}
