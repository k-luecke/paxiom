#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const path = resolve(process.argv[2] || 'fixtures/mainnet-14814119-14814120.json');
const fixture = JSON.parse(await readFile(path, 'utf8'));
const claimedHash = fixture.fixture_sha256;
const actualHash = sha256(canonicalJson({ ...fixture, fixture_sha256: null }));
if (claimedHash !== actualHash) {
  throw new Error(`fixture digest mismatch: claimed ${claimedHash}, computed ${actualHash}`);
}
if (fixture.schema !== 'paxiom-ethereum-sync-update-fixture-v2') {
  throw new Error(`unsupported fixture schema ${fixture.schema}`);
}
if (fixture.network !== 'mainnet' || fixture.sync_committee_pubkeys.length !== 512) {
  throw new Error('fixture is not a 512-member Ethereum mainnet committee fixture');
}
if (fixture.updates.length < 2) throw new Error('fixture must contain at least two updates');

for (const [index, update] of fixture.updates.entries()) {
  const participants = popcountHex(update.sync_committee_bits);
  if (participants < 342) throw new Error(`update ${index} has only ${participants} participants`);
  if (BigInt(update.signature_slot) <= BigInt(update.attested_header.slot)) {
    throw new Error(`update ${index} signature slot does not follow attested slot`);
  }
  console.log(
    `update[${index}] parent_slot=${update.parent_header.slot} attested_slot=${update.attested_header.slot} signature_slot=${update.signature_slot} participants=${participants} root=${update.attested_beacon_root}`,
  );
}

console.log(`fixture_sha256=${actualHash}`);

function popcountHex(value) {
  const bytes = Buffer.from(value.replace(/^0x/, ''), 'hex');
  let count = 0;
  for (const byte of bytes) {
    let value = byte;
    while (value) {
      value &= value - 1;
      count += 1;
    }
  }
  return count;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}
