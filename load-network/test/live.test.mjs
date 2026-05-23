// Live test against the real https://load.network endpoint.
// Gated behind LOAD_NETWORK_LIVE=1 so CI never hits the network.
// Closes the operator side of A-120 / S.03 ("end-to-end").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoadNetworkClient } from '../client.mjs';
import { LoadNetworkDataError } from '../errors.mjs';
import { reconstructAccountState } from '../reconstruct.mjs';

if (process.env.LOAD_NETWORK_LIVE !== '1') {
  console.log('LOAD_NETWORK_LIVE not set; skipping live load.network test');
} else {
  const blockNumber = Number(process.env.LIVE_BLOCK || 19_000_000);
  const address = (process.env.LIVE_ADDRESS || '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2').toLowerCase();

  test('reconstructs WETH account state at frozen historical block from real load.network', async () => {
    const client = new LoadNetworkClient();
    let result;
    try {
      result = await reconstructAccountState({ blockNumber, address, client });
    } catch (e) {
      if (e instanceof LoadNetworkDataError && e.status === 404) {
        throw new Error(
          `Load Network proof API returned 404 for block ${blockNumber}. ` +
          'Set LOAD_NETWORK_URL to a provisioned archive-proof API exposing ' +
          '/v1/blocks/:block, /v1/state/:block/account/:address, and ' +
          '/v1/state/:block/storage/:address/:slot.',
          { cause: e },
        );
      }
      throw e;
    }
    assert.equal(result.address.toLowerCase(), address);
    assert.match(result.state_root, /^0x[0-9a-f]{64}$/);
    assert.equal(result.source, 'load.network');
  });
}
