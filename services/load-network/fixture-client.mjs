import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function fixtureFetch() {
  const here = dirname(fileURLToPath(import.meta.url));
  const fixturesDir = resolve(here, '..', '..', 'load-network', 'fixtures');
  const manifest = readFixture(fixturesDir, 'MANIFEST.json');
  return async (rawUrl) => {
    const url = new URL(rawUrl);
    if (url.pathname === `/v1/blocks/${manifest.block_number}`) {
      return jsonResponse(readFixture(fixturesDir, `block_${manifest.block_number}.json`));
    }
    if (url.pathname === `/v1/state/${manifest.block_number}/account/${manifest.anchor_address}`) {
      return jsonResponse(readFixture(fixturesDir, `account_${manifest.block_number}_weth.json`));
    }
    if (url.pathname === `/v1/state/${manifest.block_number}/storage/${manifest.anchor_address}/${manifest.anchor_slot}`) {
      return jsonResponse(readFixture(fixturesDir, `storage_${manifest.block_number}_weth_slot0.json`));
    }
    return { ok: false, status: 404, headers: new Map(), text: async () => 'fixture not found' };
  };
}

function readFixture(dir, name) {
  return JSON.parse(readFileSync(resolve(dir, name), 'utf8'));
}

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    headers: new Map(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}
