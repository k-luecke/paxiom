#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const endpoint = process.env.BEACON_API_URL || 'https://ethereum-beacon-api.publicnode.com';
const committeeState = process.env.BEACON_COMMITTEE_STATE || 'head';
const trustedCommitteeRoot = process.env.TRUSTED_SYNC_COMMITTEE_ROOT || `0x${'00'.repeat(32)}`;
if (!/^0x[0-9a-fA-F]{64}$/.test(trustedCommitteeRoot)) {
  throw new Error('TRUSTED_SYNC_COMMITTEE_ROOT must be 32-byte hex');
}
const firstSlot = BigInt(process.argv[2] || '14814119');
const signatureSlots = [firstSlot, firstSlot + 1n];
const output = resolve(process.argv[3] || `fixtures/mainnet-${signatureSlots[0]}-${signatureSlots[1]}.json`);

const genesis = (await get('/eth/v1/beacon/genesis')).data;
const forkSchedule = (await get('/eth/v1/config/fork_schedule')).data;
const epoch = (firstSlot - 1n) / 32n;
const fork = forkSchedule
  .filter((entry) => BigInt(entry.epoch) <= epoch)
  .sort((a, b) => Number(BigInt(b.epoch) - BigInt(a.epoch)))[0];
if (!fork) throw new Error(`no fork version found for epoch ${epoch}`);

const committeeResponse = await get(
  `/eth/v1/beacon/states/${committeeState}/sync_committees?epoch=${epoch}`,
);
const validatorIndices = committeeResponse.data.validators;
if (validatorIndices.length !== 512) {
  throw new Error(`expected 512 sync committee indices, got ${validatorIndices.length}`);
}

const validatorsByIndex = new Map();
for (let offset = 0; offset < validatorIndices.length; offset += 80) {
  const ids = [...new Set(validatorIndices.slice(offset, offset + 80))];
  const query = ids.map((id) => `id=${encodeURIComponent(id)}`).join('&');
  const response = await get(`/eth/v1/beacon/states/${committeeState}/validators?${query}`);
  for (const item of response.data) validatorsByIndex.set(item.index, item.validator.pubkey);
}
const pubkeys = validatorIndices.map((index) => {
  const pubkey = validatorsByIndex.get(index);
  if (!pubkey) throw new Error(`validator ${index} was absent from validator response`);
  return pubkey;
});

const updates = [];
for (const signatureSlot of signatureSlots) {
  const [signatureHeaderResponse, blockResponse] = await Promise.all([
    get(`/eth/v1/beacon/headers/${signatureSlot}`),
    get(`/eth/v2/beacon/blocks/${signatureSlot}`),
  ]);
  if (!signatureHeaderResponse.finalized || signatureHeaderResponse.execution_optimistic) {
    throw new Error(`signature slot ${signatureSlot} was not finalized and non-optimistic`);
  }
  const signatureHeader = signatureHeaderResponse.data.header.message;
  const attestedResponse = await get(`/eth/v1/beacon/headers/${signatureHeader.parent_root}`);
  const attestedHeader = attestedResponse.data.header.message;
  if (attestedResponse.data.root.toLowerCase() !== signatureHeader.parent_root.toLowerCase()) {
    throw new Error(`attested header root mismatch at signature slot ${signatureSlot}`);
  }
  const parentResponse = await get(`/eth/v1/beacon/headers/${attestedHeader.parent_root}`);
  const parentHeader = parentResponse.data.header.message;
  if (parentResponse.data.root.toLowerCase() !== attestedHeader.parent_root.toLowerCase()) {
    throw new Error(`parent header root mismatch at signature slot ${signatureSlot}`);
  }
  const aggregate = blockResponse.data.message.body.sync_aggregate;
  updates.push({
    parent_header: parentHeader,
    parent_beacon_root: parentResponse.data.root,
    attested_header: attestedHeader,
    attested_beacon_root: attestedResponse.data.root,
    signature_slot: signatureSlot.toString(),
    signature_block_root: signatureHeaderResponse.data.root,
    signature_block_finalized: signatureHeaderResponse.finalized,
    signature_block_execution_optimistic: signatureHeaderResponse.execution_optimistic,
    sync_committee_bits: aggregate.sync_committee_bits,
    sync_committee_signature: aggregate.sync_committee_signature,
  });
}
if (updates[0].attested_beacon_root.toLowerCase() !== updates[1].attested_header.parent_root.toLowerCase()) {
  throw new Error('selected attested headers are not parent-linked');
}

const fixture = {
  schema: 'paxiom-ethereum-sync-update-fixture-v2',
  network: 'mainnet',
  source: endpoint,
  committee_state_source: committeeState,
  captured_at: new Date().toISOString(),
  fixture_sha256: null,
  genesis_time: genesis.genesis_time,
  genesis_validators_root: genesis.genesis_validators_root,
  fork_version: fork.current_version,
  fork_epoch: fork.epoch,
  trusted_sync_committee_root: trustedCommitteeRoot,
  trust_note: trustedCommitteeRoot === `0x${'00'.repeat(32)}`
    ? 'Zero placeholder: compute the SSZ SyncCommittee root locally and rerun capture with TRUSTED_SYNC_COMMITTEE_ROOT.'
    : 'SSZ SyncCommittee root computed locally from the ordered 512 public keys; relying verifiers must pin it out of band.',
  sync_committee_validator_indices: validatorIndices,
  sync_committee_pubkeys: pubkeys,
  updates,
};
fixture.fixture_sha256 = sha256(canonicalJson({ ...fixture, fixture_sha256: null }));

await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`wrote ${output}`);
console.log(`fixture_sha256=${fixture.fixture_sha256}`);
console.log(`trusted_sync_committee_root=${trustedCommitteeRoot}`);

async function get(path) {
  const response = await fetch(`${endpoint}${path}`, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return response.json();
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}
