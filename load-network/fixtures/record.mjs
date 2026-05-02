// Operator-only: capture a fresh load.network archive bundle and write it
// into fixtures/. Required to refresh the CI fixtures with real data once
// load.network API access is provisioned.
//
// Usage:
//   LOAD_NETWORK_API_KEY=... node load-network/fixtures/record.mjs \
//     --block 19000000 \
//     --address 0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2 \
//     --slot 0x0
//
// Pick a frozen historical block. CI tests assert deterministic output so
// the chosen block must remain referenceable indefinitely.

import { LoadNetworkClient } from '../client.mjs';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const args = parseArgs(process.argv.slice(2));
const blockNumber = Number(args.block ?? 19_000_000);
const address = (args.address ?? '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2').toLowerCase();
const slot = args.slot ?? '0x0';

const here = dirname(fileURLToPath(import.meta.url));
const client = new LoadNetworkClient();

console.log(`→ capturing block ${blockNumber}`);
const block = await client.getArchivedBlock(blockNumber);
writeJSON(resolve(here, `block_${blockNumber}.json`), block);

console.log(`→ capturing account ${address}@${blockNumber}`);
const account = await client.getReconstructedState(blockNumber, address);
writeJSON(resolve(here, `account_${blockNumber}_weth.json`), account);

console.log(`→ capturing slot ${slot} on ${address}@${blockNumber}`);
const slotResp = await client.getStorageSlot(blockNumber, address, slot);
writeJSON(resolve(here, `storage_${blockNumber}_weth_slot0.json`), slotResp);

writeJSON(resolve(here, 'MANIFEST.json'), {
  block_number: blockNumber,
  anchor_address: address,
  anchor_slot: slot,
  captured_at: new Date().toISOString(),
  captured_via: 'load-network/fixtures/record.mjs',
  load_network_endpoint: process.env.LOAD_NETWORK_URL || 'https://load.network',
  files: [
    `block_${blockNumber}.json`,
    `account_${blockNumber}_weth.json`,
    `storage_${blockNumber}_weth_slot0.json`,
  ],
});

console.log(`DONE — fixture refreshed in ${here}`);

function writeJSON(path, body) {
  writeFileSync(path, JSON.stringify(body, null, 2));
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      out[a.slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}
