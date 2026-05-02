// JSON schema for the POST /v1/sync-committee/verify endpoint.
// Mirrors O-701 / S.02 verbatim. Exported so SDK consumers can validate
// requests/responses without depending on the service.

export const requestSchema = {
  type: 'object',
  required: ['slot', 'block_root', 'parent_root', 'sync_aggregate'],
  properties: {
    slot: { type: 'string', pattern: '^[0-9]+$' },
    block_root: { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$' },
    parent_root: { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$' },
    sync_aggregate: {
      type: 'object',
      required: ['sync_committee_bits', 'sync_committee_signature'],
      properties: {
        sync_committee_bits: { type: 'string', pattern: '^0x[0-9a-fA-F]+$' },
        sync_committee_signature: { type: 'string', pattern: '^0x[0-9a-fA-F]{192}$' },
      },
    },
  },
};

export const responseSchema = {
  type: 'object',
  required: [
    'verified', 'service', 'slot', 'fork_version', 'domain', 'signing_root',
    'participating', 'committee_size', 'primitive_return_code',
    'platform_signature', 'ao_message_id',
  ],
  properties: {
    verified: { type: 'boolean' },
    service: { const: 'A-202' },
    slot: { type: 'string' },
    fork_version: { type: 'string', pattern: '^0x[0-9a-fA-F]{8}$' },
    domain: { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$' },
    signing_root: { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$' },
    participating: { type: 'integer', minimum: 0 },
    committee_size: { type: 'integer', minimum: 0 },
    primitive_return_code: { type: 'integer' },
    platform_signature: { type: 'string', pattern: '^0x[0-9a-fA-F]+$' },
    ao_message_id: { type: 'string' },
  },
};

// Tiny request validator — covers the four shape rules in requestSchema
// without pulling in ajv. The service can add ajv later if validation
// requirements grow.
export function validateRequest(body) {
  if (!body || typeof body !== 'object') {
    return 'body must be an object';
  }
  const {
    slot, block_root, parent_root, sync_aggregate,
  } = body;
  if (!/^[0-9]+$/.test(slot ?? '')) return 'slot: must be a numeric string';
  if (!/^0x[0-9a-fA-F]{64}$/.test(block_root ?? '')) return 'block_root: 32-byte hex required';
  if (!/^0x[0-9a-fA-F]{64}$/.test(parent_root ?? '')) return 'parent_root: 32-byte hex required';
  if (!sync_aggregate || typeof sync_aggregate !== 'object') {
    return 'sync_aggregate: required object';
  }
  if (!/^0x[0-9a-fA-F]+$/.test(sync_aggregate.sync_committee_bits ?? '')) {
    return 'sync_aggregate.sync_committee_bits: hex required';
  }
  if (!/^0x[0-9a-fA-F]{192}$/.test(sync_aggregate.sync_committee_signature ?? '')) {
    return 'sync_aggregate.sync_committee_signature: 96-byte hex required';
  }
  return null;
}
