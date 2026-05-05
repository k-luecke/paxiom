import { createHash } from 'node:crypto';

const SUPPORTED_CHAINS = new Set(['ethereum', 'optimism', 'arbitrum', 'base']);

export function simulateTransaction(input) {
  if (!input || typeof input !== 'object') throw new Error('simulation request must be an object');
  const chain = String(input.chain || '').toLowerCase();
  if (!SUPPORTED_CHAINS.has(chain)) throw new Error(`unsupported chain: ${chain}`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.to || '')) throw new Error('to must be a 20-byte address');
  if (!/^0x[0-9a-fA-F]*$/.test(input.data || '0x')) throw new Error('data must be hex');
  if (input.from && !/^0x[0-9a-fA-F]{40}$/.test(input.from)) throw new Error('from must be a 20-byte address');

  const request = {
    chain,
    from: input.from || null,
    to: input.to,
    data: input.data || '0x',
    value: input.value || '0',
    blockTag: input.blockTag || 'latest',
  };
  const requestHash = hashJson(request);
  return {
    service: 'A-204',
    simulation_id: `sim-${requestHash.slice(0, 16)}`,
    mode: process.env.SIMULATION_MODE || 'reference',
    chain,
    request,
    request_hash: `0x${requestHash}`,
    success: true,
    gas_used: estimateGas(request),
    state_changes: [],
    logs: [],
    tee_attestation: process.env.TEE_ATTESTATION_MODE === '1'
      ? { status: 'requested_not_available_in_reference_service' }
      : null,
    note: 'Reference-mode receipt validates request shape and produces a deterministic simulation receipt; live EVM execution is the next integration step.',
  };
}

function estimateGas(request) {
  const calldataBytes = Math.max(0, (request.data.length - 2) / 2);
  return 21_000 + calldataBytes * 16;
}

function hashJson(value) {
  return createHash('sha256').update(JSON.stringify(value, Object.keys(value).sort())).digest('hex');
}
