#!/usr/bin/env node
// Generates the static MVP fixtures for fixture-proof-verifier-v0.
//
// Run once to (re)materialize the JSON files in this directory:
//   node services/local-verifier/fixtures/make.mjs
//
// The generator is checked in alongside the fixtures so anyone can
// regenerate them deterministically. The fixtures themselves are also
// checked in so the verifier can be exercised without first running this
// script.

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../lib/canonical.mjs';

const here = dirname(fileURLToPath(import.meta.url));

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function build({ id, description, payload, tamperHash = false }) {
  const expected = sha256Hex(canonicalJson(payload));
  const stored = tamperHash ? flipFirstNibble(expected) : expected;
  return {
    fixture_id: id,
    fixture_kind: 'canonical-json-sha256-v0',
    description,
    payload,
    expected_canonical_sha256: stored,
    note: 'Static MVP fixture. Deterministic, no network. Replays sha256 of canonical-JSON of payload and compares to expected_canonical_sha256.',
  };
}

function flipFirstNibble(hex) {
  const first = parseInt(hex[0], 16);
  return ((first ^ 0xf).toString(16)) + hex.slice(1);
}

const fixtures = [
  build({
    id: 'fp-v0-canonical-pass',
    description: 'Recomputed canonical-JSON sha256 matches expected_canonical_sha256.',
    payload: { claim: 'hello-paxiom', version: 1, items: [1, 2, 3] },
  }),
  build({
    id: 'fp-v0-canonical-fail',
    description: 'expected_canonical_sha256 has been intentionally tampered. Recompute will not match. Caller claiming "fail" is correct.',
    payload: { claim: 'hello-paxiom', version: 1, items: [1, 2, 3] },
    tamperHash: true,
  }),
];

for (const f of fixtures) {
  const path = join(here, `${f.fixture_id}.json`);
  writeFileSync(path, JSON.stringify(f, null, 2) + '\n');
  console.log(`wrote ${path}`);
}
