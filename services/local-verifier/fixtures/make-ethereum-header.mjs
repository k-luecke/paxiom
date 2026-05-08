#!/usr/bin/env node
// Generates the static MVP Ethereum block-header fixtures for
// ethereum-header-fixture-verifier-v0.
//
//   node services/local-verifier/fixtures/make-ethereum-header.mjs
//
// Produces two fixtures:
//   eth-header-v0-good.json     header + recomputed block_hash
//   eth-header-v0-tampered.json same header bytes, declared block_hash flipped
//
// The header is hand-built (NOT from any real chain). The block_hash is
// keccak256(rlp(header)) computed at generation time using the same
// libraries the verifier consumes, so the good fixture is correct by
// construction.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RLP } from '@ethereumjs/rlp';
import { keccak256 } from 'ethereum-cryptography/keccak.js';

const here = dirname(fileURLToPath(import.meta.url));

// 15-field classic (pre-EIP-1559) Ethereum block header.
// Hashes/addresses/bloom/mix_hash/nonce: fixed-length byte strings.
// difficulty/number/gas_limit/gas_used/timestamp: RLP quantities (leading zeros stripped).
// extra_data: variable-length byte string.
const header = {
  parent_hash:       '0x' + 'aa'.repeat(32),
  ommers_hash:       '0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347',
  coinbase:          '0x' + '00'.repeat(20),
  state_root:        '0x' + '11'.repeat(32),
  transactions_root: '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421',
  receipts_root:     '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421',
  logs_bloom:        '0x' + '00'.repeat(256),
  difficulty:        '0x0',
  number:            '0x10',
  gas_limit:         '0x1c9c380',
  gas_used:          '0x0',
  timestamp:         '0x65b1c100',
  extra_data:        '0x',
  mix_hash:          '0x' + 'cc'.repeat(32),
  nonce:             '0x0000000000000000',
};

const RLP_ORDER = [
  'parent_hash', 'ommers_hash', 'coinbase', 'state_root',
  'transactions_root', 'receipts_root', 'logs_bloom',
  'difficulty', 'number', 'gas_limit', 'gas_used', 'timestamp',
  'extra_data', 'mix_hash', 'nonce',
];
const QUANTITY = new Set(['difficulty', 'number', 'gas_limit', 'gas_used', 'timestamp']);

function hexToBytes(hex, { quantity = false } = {}) {
  let s = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (s.length % 2 !== 0) {
    if (!quantity) throw new Error(`odd-length hex on non-quantity field: ${hex}`);
    s = '0' + s;
  }
  if (s.length === 0) return new Uint8Array(0);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function stripLeading(bytes) {
  let i = 0;
  while (i < bytes.length && bytes[i] === 0) i++;
  return bytes.slice(i);
}

function bytesToHex(bytes) {
  return '0x' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function flipFirstNibble(hex) {
  const h = hex.slice(2);
  const first = parseInt(h[0], 16);
  return '0x' + (first ^ 0xf).toString(16) + h.slice(1);
}

const rlpInput = RLP_ORDER.map((f) => (
  QUANTITY.has(f)
    ? stripLeading(hexToBytes(header[f], { quantity: true }))
    : hexToBytes(header[f])
));
const blockHash = bytesToHex(keccak256(RLP.encode(rlpInput)));

const goodFixture = {
  fixture_id: 'eth-header-v0-good',
  fixture_kind: 'ethereum-block-header-v0',
  description: 'Static MVP fixture: hand-built 15-field Ethereum-spec header (pre-EIP-1559 classic format). block_hash is keccak256(rlp(header)) computed at fixture generation time. Not from any real chain.',
  header,
  block_hash: blockHash,
  note: 'Static MVP fixture. Deterministic. No live chain claim. Regenerate via services/local-verifier/fixtures/make-ethereum-header.mjs.',
};

const tamperedFixture = {
  ...goodFixture,
  fixture_id: 'eth-header-v0-tampered',
  description: 'Static MVP fixture: same header bytes as eth-header-v0-good, but declared block_hash has its first nibble flipped. The verifier recomputes keccak(rlp(header)) and surfaces the inconsistency in details.fixture_consistent. Caller claiming the declared (wrong) hash will get ethereum_header_mismatch; caller claiming the recomputed (correct) hash will get ethereum_header_valid.',
  block_hash: flipFirstNibble(blockHash),
};

writeFileSync(join(here, 'eth-header-v0-good.json'), JSON.stringify(goodFixture, null, 2) + '\n');
writeFileSync(join(here, 'eth-header-v0-tampered.json'), JSON.stringify(tamperedFixture, null, 2) + '\n');
console.log('wrote eth-header-v0-good.json and eth-header-v0-tampered.json');
console.log('block_hash:', blockHash);
